const express = require('express');
const { v4: uuidv4 } = require('uuid');
const promClient = require('prom-client');
const winston = require('winston');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3002;
const SERVICE_NAME = 'payments-service';

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

const paymentsProcessed = new promClient.Counter({
  name: 'payments_processed_total',
  help: 'Total de pagamentos processados',
  labelNames: ['status', 'method'],
  registers: [register]
});

const paymentAmount = new promClient.Histogram({
  name: 'payment_amount',
  help: 'Valor dos pagamentos processados',
  buckets: [10, 50, 100, 500, 1000, 5000],
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

// Guardo os pagamentos em memória (mock)
const payments = [];

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
    paymentsProcessed: payments.length
  });
});

// POST - processa um pagamento
app.post('/payments', (req, res) => {
  const { orderId, amount, method, cardLastFour } = req.body;

  if (!orderId || !amount || !method) {
    logger.warn('Invalid payment request', { traceId: req.traceId, body: req.body });
    return res.status(400).json({
      error: 'Campos obrigatórios: orderId, amount, method',
      traceId: req.traceId
    });
  }

  // Simulo uma latência de processamento
  const processingTime = Math.random() * 100;

  // 90% de chance de aprovar (mock)
  const isApproved = Math.random() > 0.1;

  const payment = {
    id: uuidv4(),
    orderId,
    amount,
    method,
    cardLastFour: cardLastFour || null,
    status: isApproved ? 'APPROVED' : 'REJECTED',
    transactionId: isApproved ? `TXN-${Date.now()}` : null,
    processedAt: new Date().toISOString()
  };

  payments.push(payment);

  // Registro nas métricas
  paymentsProcessed.inc({ status: payment.status, method });
  paymentAmount.observe(amount);

  logger.info('Payment processed', {
    traceId: req.traceId,
    paymentId: payment.id,
    orderId,
    amount,
    status: payment.status,
    processingTime: `${processingTime.toFixed(2)}ms`
  });

  const statusCode = isApproved ? 201 : 402;
  res.status(statusCode).json({
    message: isApproved ? 'Pagamento aprovado' : 'Pagamento rejeitado',
    payment,
    traceId: req.traceId
  });
});

// GET - busca um pagamento específico
app.get('/payments/:id', (req, res) => {
  const payment = payments.find(p => p.id === req.params.id);

  if (!payment) {
    return res.status(404).json({ error: 'Pagamento não encontrado', traceId: req.traceId });
  }

  res.json(payment);
});

// GET - busca pagamentos de um pedido
app.get('/payments/order/:orderId', (req, res) => {
  const orderPayments = payments.filter(p => p.orderId === req.params.orderId);

  res.json({
    orderId: req.params.orderId,
    total: orderPayments.length,
    payments: orderPayments,
    traceId: req.traceId
  });
});

// POST - estorna um pagamento
app.post('/payments/:id/refund', (req, res) => {
  const paymentIndex = payments.findIndex(p => p.id === req.params.id);

  if (paymentIndex === -1) {
    return res.status(404).json({ error: 'Pagamento não encontrado', traceId: req.traceId });
  }

  if (payments[paymentIndex].status !== 'APPROVED') {
    return res.status(400).json({
      error: 'Apenas pagamentos aprovados podem ser estornados',
      traceId: req.traceId
    });
  }

  payments[paymentIndex].status = 'REFUNDED';
  payments[paymentIndex].refundedAt = new Date().toISOString();

  logger.info('Payment refunded', {
    traceId: req.traceId,
    paymentId: req.params.id
  });

  res.json({
    message: 'Estorno realizado com sucesso',
    payment: payments[paymentIndex],
    traceId: req.traceId
  });
});

app.listen(PORT, () => {
  logger.info(`${SERVICE_NAME} started`, { port: PORT });
});
