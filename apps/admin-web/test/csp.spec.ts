import * as fs from 'fs';
import * as path from 'path';

describe('Content Security Policy (ADR-008 & TASK-007 Round 2)', () => {
  it('does not contain unsafe-eval in script-src CSP header', () => {
    const configPath = path.resolve(__dirname, '../next.config.mjs');
    const content = fs.readFileSync(configPath, 'utf8');

    expect(content).toContain('Content-Security-Policy');
    expect(content).not.toContain('unsafe-eval');
    expect(content).toContain("default-src 'self'");
    expect(content).toContain("frame-ancestors 'none'");
  });
});
