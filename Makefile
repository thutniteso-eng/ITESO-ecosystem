SHELL := /usr/bin/env bash
COMPOSE := docker compose --env-file .env -f infra/docker-compose.yml

.PHONY: up down reset seed test logs ps

up:
	@if [ ! -f .env ]; then \
		echo "ERROR: .env not found. Run: cp .env.example .env"; \
		exit 1; \
	fi
	./scripts/generate-keys.sh
	$(COMPOSE) build control-plane
	$(COMPOSE) up -d --wait postgres
	./scripts/init-db-roles.sh
	$(COMPOSE) run --rm control-plane node dist/db/migrate.js
	$(COMPOSE) run --rm control-plane node dist/db/seed.js
	$(COMPOSE) up -d --build --wait
	./scripts/init-demo-tenant.sh
	$(COMPOSE) exec -T control-plane node dist/cli/provision-odoo-users.js --tenant demo_fnb

down:
	$(COMPOSE) down

reset:
	@if [ ! -f .env ]; then \
		echo "ERROR: .env not found. Run: cp .env.example .env"; \
		exit 1; \
	fi
	./scripts/generate-keys.sh
	$(COMPOSE) down -v --remove-orphans
	$(COMPOSE) build control-plane
	$(COMPOSE) up -d --wait postgres
	./scripts/init-db-roles.sh
	$(COMPOSE) run --rm control-plane node dist/db/migrate.js
	$(COMPOSE) run --rm control-plane node dist/db/seed.js
	$(COMPOSE) up -d --build --wait
	./scripts/init-demo-tenant.sh
	$(COMPOSE) exec -T control-plane node dist/cli/provision-odoo-users.js --tenant demo_fnb

seed:
	@echo "Dữ liệu nhà hàng mẫu sẽ có ở task sau."

create-platform-admin:
	@read -p "Email: " email; \
	read -s -p "Password: " password; echo ""; \
	$(COMPOSE) run --rm control-plane node dist/cli/create-platform-admin.js --email "$$email" --password "$$password"

test:
	pnpm --filter @iteso/control-plane test
	pnpm --filter @iteso/gateway test
	pnpm --filter @iteso/admin-web test
	./scripts/test-db-isolation.sh
	./scripts/test-odoo-module.sh
	node ./scripts/test-acceptance-criteria.js
	node ./scripts/test-acceptance-criteria-task006.js


ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f --tail=100
