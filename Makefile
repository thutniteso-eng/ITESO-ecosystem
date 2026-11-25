SHELL := /usr/bin/env bash
COMPOSE := docker compose --env-file .env -f infra/docker-compose.yml

.PHONY: up down reset seed test logs ps

up:
	@if [ ! -f .env ]; then \
		echo "ERROR: .env not found. Run: cp .env.example .env"; \
		exit 1; \
	fi
	$(COMPOSE) up -d --wait postgres
	./scripts/init-db-roles.sh
	$(COMPOSE) up -d --build --wait
	./scripts/init-demo-tenant.sh

down:
	$(COMPOSE) down

reset:
	@if [ ! -f .env ]; then \
		echo "ERROR: .env not found. Run: cp .env.example .env"; \
		exit 1; \
	fi
	$(COMPOSE) down -v --remove-orphans
	$(COMPOSE) up -d --wait postgres
	./scripts/init-db-roles.sh
	$(COMPOSE) up -d --build --wait
	./scripts/init-demo-tenant.sh

seed:
	@echo "Dữ liệu nhà hàng mẫu sẽ có ở task sau."

test:
	pnpm --filter @iteso/gateway test
	./scripts/test-db-isolation.sh
	./scripts/test-odoo-module.sh

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f --tail=100
