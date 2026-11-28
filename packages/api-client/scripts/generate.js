const { execSync } = require('child_process');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(packageRoot, '../..');

const cpOpenApi = path.join(projectRoot, 'services/control-plane/openapi.json');
const gwOpenApi = path.join(projectRoot, 'services/gateway/openapi.json');

const cpOut = path.join(packageRoot, 'src/control-plane.types.ts');
const gwOut = path.join(packageRoot, 'src/gateway.types.ts');

console.log('[api-client:gen] Generating TypeScript types from OpenAPI specs...');
execSync(`npx openapi-typescript "${cpOpenApi}" -o "${cpOut}"`, {
  cwd: packageRoot,
  stdio: 'inherit',
});

execSync(`npx openapi-typescript "${gwOpenApi}" -o "${gwOut}"`, {
  cwd: packageRoot,
  stdio: 'inherit',
});

console.log('[api-client:gen] Types generated successfully.');
