# Pedidos Veloz - Plataforma de Microsserviços

Projeto acadêmico de modernização de e-commerce utilizando arquitetura de microsserviços, containerização com Docker, orquestração com Kubernetes, observabilidade completa e CI/CD automatizado.

**Aluno:** Samuel Sousa Nunes
**Disciplina:** Cloud DevOps: Orchestrating Containers and Micro Services
**Instituição:** UniFECAF

---

## Arquitetura

```
                         ┌─────────────────┐
                         │   Cliente/UI    │
                         └────────┬────────┘
                                  │
                         ┌────────▼────────┐
                         │   API Gateway   │
                         │   (porta 3000)  │
                         └────────┬────────┘
                                  │
         ┌────────────────────────┼────────────────────────┐
         │                        │                        │
┌────────▼────────┐    ┌─────────▼─────────┐    ┌────────▼────────┐
│  Orders Service │    │ Payments Service  │    │Inventory Service│
│  (porta 3001)   │    │   (porta 3002)    │    │  (porta 3003)   │
└────────┬────────┘    └─────────┬─────────┘    └────────┬────────┘
         │                       │                        │
         └───────────────────────┼────────────────────────┘
                                 │
                      ┌──────────▼──────────┐
                      │     PostgreSQL      │
                      └─────────────────────┘

     ┌────────────────── OBSERVABILIDADE ──────────────────┐
     │  Prometheus (9090)  ←→  Grafana (3030)  ←→  Jaeger  │
     └─────────────────────────────────────────────────────┘
```

---

## Estrutura do Projeto

```
pedidos-veloz-microservices/
├── api-gateway/              # Gateway de entrada
│   ├── server.js
│   ├── tracing.js
│   ├── package.json
│   └── Dockerfile
├── orders-service/           # Serviço de pedidos
├── payments-service/         # Serviço de pagamentos
├── inventory-service/        # Serviço de inventário
├── k8s/                      # Manifestos Kubernetes
│   ├── observability/
│   ├── namespace.yaml
│   ├── configmap.yaml
│   ├── secret.yaml
│   ├── postgres.yaml
│   ├── *-service.yaml
│   ├── hpa-orders.yaml
│   └── kustomization.yaml
├── observability/            # Configurações
│   ├── prometheus/
│   └── grafana/
├── .github/workflows/        # Pipeline CI/CD
│   └── pipeline.yml
├── docker-compose.yml
└── README.md
```

---

## Execução Rápida

### Pré-requisitos
- Docker 24+
- Docker Compose v2
- Node.js 20+ (para desenvolvimento)
- kubectl (para Kubernetes)

### Ambiente Local (Docker Compose)

```bash
# Clonar repositório
git clone <repo-url>
cd pedidos-veloz-microservices

# Subir todos os serviços
docker-compose up -d

# Verificar status
docker-compose ps

# Ver logs
docker-compose logs -f api-gateway

# Parar tudo
docker-compose down
```

### URLs Locais

| Serviço | URL |
|---------|-----|
| API Gateway | http://localhost:3000 |
| Orders Service | http://localhost:3001 |
| Payments Service | http://localhost:3002 |
| Inventory Service | http://localhost:3003 |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3030 |
| Jaeger UI | http://localhost:16686 |
| PostgreSQL | localhost:5432 |

**Credenciais Grafana:** admin / admin

---

## Endpoints da API

### Health Checks
```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/health/all
curl http://localhost:3000/metrics
```

### Pedidos
```bash
# Criar pedido
curl -X POST http://localhost:3000/api/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "CUST-001",
    "items": [
      {"productId": "PROD-001", "quantity": 2},
      {"productId": "PROD-002", "quantity": 1}
    ],
    "totalAmount": 229.70
  }'

# Listar pedidos
curl http://localhost:3000/api/orders
```

### Pagamentos
```bash
curl -X POST http://localhost:3000/api/payments \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "uuid-do-pedido",
    "amount": 229.70,
    "method": "CREDIT_CARD",
    "cardLastFour": "1234"
  }'
```

### Inventário
```bash
curl http://localhost:3000/api/inventory

curl -X POST http://localhost:3000/api/inventory/PROD-001/reserve \
  -H "Content-Type: application/json" \
  -d '{"quantity": 5}'
```

---

## Deploy Kubernetes

```bash
# Aplicar manifestos
kubectl apply -k k8s/

# Verificar recursos
kubectl get all -n pedidos-veloz

# Verificar pods
kubectl get pods -n pedidos-veloz -w

# Verificar HPA
kubectl get hpa -n pedidos-veloz

# Ver logs
kubectl logs -f deployment/api-gateway -n pedidos-veloz
```

### Acessar Serviços

```bash
kubectl port-forward svc/api-gateway 3000:80 -n pedidos-veloz
kubectl port-forward svc/grafana 3030:80 -n pedidos-veloz
```

---

## CI/CD Pipeline

O pipeline GitHub Actions executa:

1. **Test & Lint** - Validação de código
2. **Build** - Construção de imagens Docker
3. **Push** - Publicação no Docker Hub
4. **Validate K8s** - Validação de manifestos
5. **Security Scan** - Trivy
6. **Deploy Staging** - Branch `develop`
7. **Deploy Production** - Branch `main`

### Secrets Necessários

Configure no GitHub:
- `DOCKER_USERNAME` - Usuário Docker Hub
- `DOCKER_PASSWORD` - Token Docker Hub

---

## Observabilidade

### Métricas (Prometheus)

Cada serviço expõe métricas em `/metrics`:
- `http_requests_total` - Contador de requisições
- `http_request_duration_seconds` - Latência
- `orders_created_total` - Total de pedidos
- `payments_processed_total` - Pagamentos por status
- `inventory_level` - Nível de estoque

### Dashboards (Grafana)

Dashboard pré-configurado com requisições por segundo, latência, taxa de sucesso, pedidos criados e nível de estoque.

### Tracing (Jaeger)

Trace ID propagado entre serviços via header `x-trace-id`.
Visualização: http://localhost:16686

---

## Tecnologias

| Categoria | Tecnologia |
|-----------|------------|
| Runtime | Node.js 20 + Express |
| Containers | Docker + Docker Compose |
| Orquestração | Kubernetes |
| CI/CD | GitHub Actions |
| Métricas | Prometheus |
| Dashboards | Grafana |
| Tracing | Jaeger |
| Banco de Dados | PostgreSQL 15 |

---

Desenvolvido por **Samuel Sousa Nunes** - UniFECAF 2026
