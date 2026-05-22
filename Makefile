.PHONY: install build test lint typecheck clean dev smoke models

install:
	npm install
	cd bridge && npm install
	npm run build

build:
	cd bridge && npx tsc
	npx tsc -p tsconfig.json

test:
	npx vitest run

lint:
	npx tsc -p tsconfig.json --noEmit
	cd bridge && npx tsc --noEmit

typecheck: lint

clean:
	rm -rf dist bridge/dist

dev:
	npx tsx src/cli.ts

models:
	node -e "
	const {MODEL_CATALOG} = require('./bridge/dist/types.js');
	MODEL_CATALOG.forEach(m => console.log(m.id.padEnd(22), m.displayName, m.thinking ? '(thinking)' : ''));
	"

smoke:
	@echo "=== Model catalog ==="
	@node -e "
	import('./bridge/dist/types.js').then(t => {
		t.MODEL_CATALOG.forEach(m => console.log('  ' + m.id + ' → ' + m.providerModel, m.thinking ? '(thinking)' : ''));
	});
	"
	@echo ""
	@echo "=== tests ==="
	npx vitest run
	@echo ""
	@echo "=== build ==="
	@echo "Bridge: $$(ls bridge/dist/*.js | wc -l) files"
	@echo "CLI:    $$(ls dist/*.js | wc -l) files"
	@echo ""
	@echo "✓ smoke check passed"

.DEFAULT_GOAL := smoke
