const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const promClient = require('prom-client');
const winston = require('winston');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SERVICE_NAME = 'api-gateway';

// Meu logger em JSON pro Grafana conseguir parsear
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: SERVICE_NAME },
  transports: [
    new winston.transports.Console()
  ]
});

// Métricas pro Prometheus
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// Minhas métricas customizadas
const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total de requisições HTTP',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duração das requisições HTTP em segundos',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.5, 1, 2, 5],
  registers: [register]
});

const activeRequests = new promClient.Gauge({
  name: 'http_active_requests',
  help: 'Número de requisições ativas',
  registers: [register]
});

// Middleware que uso pra coletar métricas e propagar trace
app.use((req, res, next) => {
  // Se não veio traceId no header, eu gero um novo
  req.traceId = req.headers['x-trace-id'] || uuidv4();
  req.spanId = uuidv4();

  const startTime = Date.now();
  activeRequests.inc();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const route = req.route?.path || req.path;

    httpRequestsTotal.inc({
      method: req.method,
      route: route,
      status_code: res.statusCode
    });

    httpRequestDuration.observe({
      method: req.method,
      route: route,
      status_code: res.statusCode
    }, duration);

    activeRequests.dec();

    // Loga a requisição completa
    logger.info('Request completed', {
      traceId: req.traceId,
      spanId: req.spanId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}s`,
      userAgent: req.headers['user-agent']
    });
  });

  next();
});

// URLs dos meus microsserviços (pego das env vars)
const SERVICES = {
  orders: process.env.ORDERS_SERVICE_URL || 'http://orders-service:3001',
  payments: process.env.PAYMENTS_SERVICE_URL || 'http://payments-service:3002',
  inventory: process.env.INVENTORY_SERVICE_URL || 'http://inventory-service:3003'
};

// Monto os headers de tracing pra propagar entre serviços
const getTracingHeaders = (req) => ({
  'x-trace-id': req.traceId,
  'x-span-id': req.spanId,
  'x-parent-span-id': req.spanId
});

// Endpoint que o Prometheus faz scrape
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Health check simples
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString()
  });
});

// Readiness - checo se os outros serviços estão de pé
app.get('/ready', async (req, res) => {
  const checks = {};
  let allHealthy = true;

  for (const [name, url] of Object.entries(SERVICES)) {
    try {
      await axios.get(`${url}/health`, { timeout: 2000 });
      checks[name] = 'healthy';
    } catch {
      checks[name] = 'unhealthy';
      allHealthy = false;
    }
  }

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ready' : 'not_ready',
    dependencies: checks
  });
});

// Rotas de pedidos - repasso pro orders-service
app.post('/api/orders', async (req, res) => {
  try {
    logger.info('Forwarding create order request', { traceId: req.traceId });
    const response = await axios.post(`${SERVICES.orders}/orders`, req.body, {
      headers: getTracingHeaders(req)
    });
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to create order', {
      traceId: req.traceId,
      error: error.message
    });
    res.status(error.response?.status || 500).json({
      error: 'Falha ao processar pedido',
      details: error.message,
      traceId: req.traceId
    });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const response = await axios.get(`${SERVICES.orders}/orders`, {
      headers: getTracingHeaders(req)
    });
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to fetch orders', { traceId: req.traceId, error: error.message });
    res.status(error.response?.status || 500).json({
      error: 'Falha ao buscar pedidos',
      details: error.message,
      traceId: req.traceId
    });
  }
});

// Rotas de pagamentos - repasso pro payments-service
app.post('/api/payments', async (req, res) => {
  try {
    logger.info('Forwarding payment request', { traceId: req.traceId });
    const response = await axios.post(`${SERVICES.payments}/payments`, req.body, {
      headers: getTracingHeaders(req)
    });
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to process payment', { traceId: req.traceId, error: error.message });
    res.status(error.response?.status || 500).json({
      error: 'Falha ao processar pagamento',
      details: error.message,
      traceId: req.traceId
    });
  }
});

app.get('/api/payments/:id', async (req, res) => {
  try {
    const response = await axios.get(`${SERVICES.payments}/payments/${req.params.id}`, {
      headers: getTracingHeaders(req)
    });
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to fetch payment', { traceId: req.traceId, error: error.message });
    res.status(error.response?.status || 500).json({
      error: 'Falha ao buscar pagamento',
      details: error.message,
      traceId: req.traceId
    });
  }
});

// Rotas de inventário - repasso pro inventory-service
app.get('/api/inventory', async (req, res) => {
  try {
    const response = await axios.get(`${SERVICES.inventory}/inventory`, {
      headers: getTracingHeaders(req)
    });
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to fetch inventory', { traceId: req.traceId, error: error.message });
    res.status(error.response?.status || 500).json({
      error: 'Falha ao buscar inventário',
      details: error.message,
      traceId: req.traceId
    });
  }
});

app.put('/api/inventory/:productId', async (req, res) => {
  try {
    const response = await axios.put(
      `${SERVICES.inventory}/inventory/${req.params.productId}`,
      req.body,
      { headers: getTracingHeaders(req) }
    );
    res.json(response.data);
  } catch (error) {
    logger.error('Failed to update inventory', { traceId: req.traceId, error: error.message });
    res.status(error.response?.status || 500).json({
      error: 'Falha ao atualizar estoque',
      details: error.message,
      traceId: req.traceId
    });
  }
});

// Checa a saúde de todo mundo de uma vez
app.get('/api/health/all', async (req, res) => {
  const healthChecks = {};

  for (const [name, url] of Object.entries(SERVICES)) {
    try {
      const response = await axios.get(`${url}/health`, {
        timeout: 3000,
        headers: getTracingHeaders(req)
      });
      healthChecks[name] = response.data;
    } catch (error) {
      healthChecks[name] = { status: 'unhealthy', error: error.message };
    }
  }

  res.json({
    gateway: { status: 'healthy' },
    services: healthChecks,
    traceId: req.traceId
  });
});

app.listen(PORT, () => {
  logger.info(`${SERVICE_NAME} started`, { port: PORT, services: SERVICES });
});
