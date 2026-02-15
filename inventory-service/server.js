const express = require('express');
const promClient = require('prom-client');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3003;
const SERVICE_NAME = 'inventory-service';

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

const inventoryLevel = new promClient.Gauge({
  name: 'inventory_level',
  help: 'Nível de estoque por produto',
  labelNames: ['product_id', 'product_name'],
  registers: [register]
});

const inventoryReservations = new promClient.Counter({
  name: 'inventory_reservations_total',
  help: 'Total de reservas de estoque',
  labelNames: ['product_id', 'result'],
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

// Meus produtos em memória (mock)
const inventory = [
  { productId: 'PROD-001', name: 'Camiseta Básica', quantity: 100, price: 49.90, reserved: 0 },
  { productId: 'PROD-002', name: 'Calça Jeans', quantity: 50, price: 129.90, reserved: 0 },
  { productId: 'PROD-003', name: 'Tênis Esportivo', quantity: 30, price: 299.90, reserved: 0 },
  { productId: 'PROD-004', name: 'Boné Veloz', quantity: 200, price: 39.90, reserved: 0 },
  { productId: 'PROD-005', name: 'Mochila Urban', quantity: 25, price: 189.90, reserved: 0 }
];

// Atualizo as métricas de estoque
const updateInventoryMetrics = () => {
  inventory.forEach(item => {
    inventoryLevel.set(
      { product_id: item.productId, product_name: item.name },
      item.quantity - item.reserved
    );
  });
};
updateInventoryMetrics();

// Endpoint pro Prometheus
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// Health check básico
app.get('/health', (req, res) => {
  const totalItems = inventory.reduce((acc, item) => acc + item.quantity, 0);

  res.json({
    status: 'healthy',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
    productsTracked: inventory.length,
    totalItemsInStock: totalItems
  });
});

// GET - lista todo o estoque
app.get('/inventory', (req, res) => {
  res.json({
    total: inventory.length,
    products: inventory.map(item => ({
      ...item,
      available: item.quantity - item.reserved
    })),
    traceId: req.traceId
  });
});

// GET - busca um produto
app.get('/inventory/:productId', (req, res) => {
  const product = inventory.find(p => p.productId === req.params.productId);

  if (!product) {
    return res.status(404).json({ error: 'Produto não encontrado', traceId: req.traceId });
  }

  res.json({
    ...product,
    available: product.quantity - product.reserved,
    traceId: req.traceId
  });
});

// PUT - atualiza quantidade no estoque
app.put('/inventory/:productId', (req, res) => {
  const { quantity } = req.body;

  if (typeof quantity !== 'number' || quantity < 0) {
    return res.status(400).json({
      error: 'Quantidade deve ser um número >= 0',
      traceId: req.traceId
    });
  }

  const productIndex = inventory.findIndex(p => p.productId === req.params.productId);

  if (productIndex === -1) {
    return res.status(404).json({ error: 'Produto não encontrado', traceId: req.traceId });
  }

  const oldQuantity = inventory[productIndex].quantity;
  inventory[productIndex].quantity = quantity;
  updateInventoryMetrics();

  logger.info('Inventory updated', {
    traceId: req.traceId,
    productId: req.params.productId,
    oldQuantity,
    newQuantity: quantity
  });

  res.json({
    message: 'Estoque atualizado',
    product: inventory[productIndex],
    traceId: req.traceId
  });
});

// POST - reserva itens pra um pedido
app.post('/inventory/:productId/reserve', (req, res) => {
  const { quantity } = req.body;

  if (!quantity || quantity <= 0) {
    return res.status(400).json({
      error: 'Quantidade para reserva deve ser > 0',
      traceId: req.traceId
    });
  }

  const productIndex = inventory.findIndex(p => p.productId === req.params.productId);

  if (productIndex === -1) {
    return res.status(404).json({ error: 'Produto não encontrado', traceId: req.traceId });
  }

  const product = inventory[productIndex];
  const available = product.quantity - product.reserved;

  if (quantity > available) {
    inventoryReservations.inc({ product_id: req.params.productId, result: 'failed' });
    logger.warn('Reservation failed - insufficient stock', {
      traceId: req.traceId,
      productId: req.params.productId,
      requested: quantity,
      available
    });

    return res.status(400).json({
      error: 'Estoque insuficiente',
      requested: quantity,
      available,
      traceId: req.traceId
    });
  }

  inventory[productIndex].reserved += quantity;
  updateInventoryMetrics();
  inventoryReservations.inc({ product_id: req.params.productId, result: 'success' });

  logger.info('Inventory reserved', {
    traceId: req.traceId,
    productId: req.params.productId,
    quantity
  });

  res.json({
    message: 'Reserva realizada',
    product: {
      ...inventory[productIndex],
      available: inventory[productIndex].quantity - inventory[productIndex].reserved
    },
    traceId: req.traceId
  });
});

// POST - libera uma reserva
app.post('/inventory/:productId/release', (req, res) => {
  const { quantity } = req.body;

  const productIndex = inventory.findIndex(p => p.productId === req.params.productId);

  if (productIndex === -1) {
    return res.status(404).json({ error: 'Produto não encontrado', traceId: req.traceId });
  }

  const releaseQty = Math.min(quantity, inventory[productIndex].reserved);
  inventory[productIndex].reserved -= releaseQty;
  updateInventoryMetrics();

  logger.info('Reservation released', {
    traceId: req.traceId,
    productId: req.params.productId,
    released: releaseQty
  });

  res.json({
    message: 'Reserva liberada',
    released: releaseQty,
    product: inventory[productIndex],
    traceId: req.traceId
  });
});

// POST - confirma saída do estoque
app.post('/inventory/:productId/confirm', (req, res) => {
  const { quantity } = req.body;

  const productIndex = inventory.findIndex(p => p.productId === req.params.productId);

  if (productIndex === -1) {
    return res.status(404).json({ error: 'Produto não encontrado', traceId: req.traceId });
  }

  const product = inventory[productIndex];

  if (quantity > product.reserved) {
    return res.status(400).json({
      error: 'Quantidade maior que reservado',
      traceId: req.traceId
    });
  }

  inventory[productIndex].quantity -= quantity;
  inventory[productIndex].reserved -= quantity;
  updateInventoryMetrics();

  logger.info('Stock confirmed out', {
    traceId: req.traceId,
    productId: req.params.productId,
    quantity
  });

  res.json({
    message: 'Saída do estoque confirmada',
    product: inventory[productIndex],
    traceId: req.traceId
  });
});

app.listen(PORT, () => {
  logger.info(`${SERVICE_NAME} started`, { port: PORT });
});
