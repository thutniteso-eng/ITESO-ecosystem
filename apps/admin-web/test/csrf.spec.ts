import { validateOrigin } from '../src/lib/csrf';

describe('CSRF Origin Validation (ADR-008)', () => {
  it('allows safe methods GET, HEAD, OPTIONS without origin check', () => {
    const getReq = new Request('http://localhost:3001/api/test', { method: 'GET' });
    expect(validateOrigin(getReq)).toBe(true);

    const headReq = new Request('http://localhost:3001/api/test', { method: 'HEAD' });
    expect(validateOrigin(headReq)).toBe(true);

    const optionsReq = new Request('http://localhost:3001/api/test', { method: 'OPTIONS' });
    expect(validateOrigin(optionsReq)).toBe(true);
  });

  it('allows mutating requests when Origin matches Host', () => {
    const postReq = new Request('http://localhost:3001/api/auth/login', {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        origin: 'http://localhost:3001',
      },
    });
    expect(validateOrigin(postReq)).toBe(true);
  });

  it('rejects mutating requests with mismatched Origin (cross-site)', () => {
    const postReq = new Request('http://localhost:3001/api/auth/login', {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        origin: 'http://evil-attacker.com',
      },
    });
    expect(validateOrigin(postReq)).toBe(false);
  });

  it('falls back to Referer if Origin is omitted and validates host', () => {
    const validRefererReq = new Request('http://localhost:3001/api/auth/login', {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        referer: 'http://localhost:3001/login',
      },
    });
    expect(validateOrigin(validRefererReq)).toBe(true);

    const evilRefererReq = new Request('http://localhost:3001/api/auth/login', {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        referer: 'http://evil-attacker.com/exploit',
      },
    });
    expect(validateOrigin(evilRefererReq)).toBe(false);
  });

  it('rejects mutating requests with no Origin and no Referer', () => {
    const noHeaderReq = new Request('http://localhost:3001/api/auth/login', {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
      },
    });
    expect(validateOrigin(noHeaderReq)).toBe(false);
  });
});
