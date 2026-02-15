const express = require('express');
const { v4: uuidv4 } = require('uuid');
const promClient = require('prom-client');
const winston = require('winston');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SERVICE_NAME = 'orders-service';

// Meu logger em JSON
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: SERVICE_NAME },
  transports: [new winston.transports.Console()]
});

// Métricas pro Prometheus
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

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

const ordersCreated = new promClient.Counter({
  name: 'orders_created_total',
  help: 'Total de pedidos criados',
  registers: [register]
});

const ordersByStatus = new promClient.Gauge({
  name: 'orders_by_status',
  help: 'Quantidade de pedidos por status',
  labelNames: ['status'],
  registers: [register]
});

// Middleware pra métricas e tracing
app.use((req, res, next) => {
  req.traceId = req.headers['x-trace-id'] || uuidv4();
  req.spanId = uuidv4();
  req.parentSpanId = req.headers['x-parent-span-id'];

  const startTime = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const route = req.route?.path || req.path;

    httpRequestsTotal.inc({ method: req.method, route, status_code: res.statusCode });
    httpRequestDuration.observe({ method: req.method, route, status_code: res.statusCode }, duration);

    logger.info('Request completed', {
      traceId: req.traceId,
      spanId: req.spanId,
      parentSpanId: req.parentSpanId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}s`
    });
  });

  next();
});

// Por enquanto guardo os pedidos em memória (mock)
const orders = [];

// Atualizo as métricas de status dos pedidos
const updateStatusMetrics = () => {
  const statusCounts = orders.reduce((acc, order) => {
    acc[order.status] = (acc[order.status] || 0) + 1;
    return acc;
  }, {});

  Object.entries(statusCounts).forEach(([status, count]) => {
    ordersByStatus.set({ status }, count);
  });
};

// Endpoint pro Prometheus
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Health check básico
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
    ordersCount: orders.length
  });
});

// POST - cria um pedido novo
app.post('/orders', (req, res) => {
  const { customerId, items, totalAmount } = req.body;

  if (!customerId || !items || !totalAmount) {
    logger.warn('Invalid order request', { traceId: req.traceId, body: req.body });
    return res.status(400).json({
      error: 'Campos obrigatórios: customerId, items, totalAmount',
      traceId: req.traceId
    });
  }

  const newOrder = {
    id: uuidv4(),
    customerId,
    items,
    totalAmount,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  orders.push(newOrder);
  ordersCreated.inc();
  updateStatusMetrics();

  logger.info('Order created', {
    traceId: req.traceId,
    orderId: newOrder.id,
    customerId,
    totalAmount
  });

  res.status(201).json({
    message: 'Pedido criado com sucesso',
    order: newOrder,
    traceId: req.traceId
  });
});

// GET - lista todos os pedidos
app.get('/orders', (req, res) => {
  res.json({
    total: orders.length,
    orders: orders,
    traceId: req.traceId
  });
});

// GET - busca um pedido específico
app.get('/orders/:id', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);

  if (!order) {
    return res.status(404).json({ error: 'Pedido não encontrado', traceId: req.traceId });
  }

  res.json(order);
});

// PATCH - atualiza o status do pedido
app.patch('/orders/:id/status', (req, res) => {
  const { status } = req.body;
  const validStatuses = ['PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({
      error: 'Status inválido',
      validStatuses,
      traceId: req.traceId
    });
  }

  const orderIndex = orders.findIndex(o => o.id === req.params.id);

  if (orderIndex === -1) {
    return res.status(404).json({ error: 'Pedido não encontrado', traceId: req.traceId });
  }

  const oldStatus = orders[orderIndex].status;
  orders[orderIndex].status = status;
  orders[orderIndex].updatedAt = new Date().toISOString();
  updateStatusMetrics();

  logger.info('Order status updated', {
    traceId: req.traceId,
    orderId: req.params.id,
    oldStatus,
    newStatus: status
  });

  res.json({
    message: 'Status atualizado',
    order: orders[orderIndex],
    traceId: req.traceId
  });
});

app.listen(PORT, () => {
  logger.info(`${SERVICE_NAME} started`, { port: PORT });
});
