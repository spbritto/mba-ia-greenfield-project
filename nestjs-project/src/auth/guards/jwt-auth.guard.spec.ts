import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { IS_OPTIONAL_AUTH_KEY } from '../decorators/optional-auth.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

const TEST_SECRET = 'test-secret';

const STUB_HANDLER = jest.fn();
const STUB_CLASS = class {};

function makeContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => STUB_HANDLER,
    getClass: () => STUB_CLASS,
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: JwtService;
  let mockReflector: { getAllAndOverride: jest.Mock };

  beforeAll(async () => {
    mockReflector = { getAllAndOverride: jest.fn() };

    const module = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: TEST_SECRET,
          signOptions: { expiresIn: '15m' },
        }),
      ],
      providers: [
        JwtAuthGuard,
        { provide: Reflector, useValue: mockReflector },
      ],
    }).compile();

    guard = module.get(JwtAuthGuard);
    jwtService = module.get(JwtService);
  });

  beforeEach(() => {
    mockReflector.getAllAndOverride.mockReset();
    mockReflector.getAllAndOverride.mockReturnValue(false);
  });

  it('bypasses guard on @Public() routes', async () => {
    mockReflector.getAllAndOverride.mockReturnValue(true);
    const ctx = makeContext({ headers: {} });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('passes with a valid JWT and attaches payload to request.user', async () => {
    const token = jwtService.sign({ sub: 'user-1', email: 'a@example.com' });
    const request: Record<string, unknown> = {
      headers: { authorization: `Bearer ${token}` },
    };
    const ctx = makeContext(request);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect((request.user as Record<string, unknown>)?.sub).toBe('user-1');
    expect((request.user as Record<string, unknown>)?.email).toBe(
      'a@example.com',
    );
  });

  it('throws UnauthorizedException when Authorization header is missing', async () => {
    const ctx = makeContext({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException on malformed Bearer token', async () => {
    const ctx = makeContext({
      headers: { authorization: 'Bearer not-a-valid-jwt' },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException on expired JWT', async () => {
    const expiredToken = jwtService.sign(
      { sub: 'user-1', email: 'a@example.com' },
      { expiresIn: -60 },
    );
    const ctx = makeContext({
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  // ── @OptionalAuth() behavior ───────────────────────────────

  describe('@OptionalAuth()', () => {
    beforeEach(() => {
      // Simulate @OptionalAuth() route: IS_PUBLIC_KEY=false, IS_OPTIONAL_AUTH_KEY=true
      mockReflector.getAllAndOverride.mockImplementation(
        (key: string) => key === IS_OPTIONAL_AUTH_KEY,
      );
    });

    it('allows anonymous access (no header) on optional-auth routes', async () => {
      const request: Record<string, unknown> = { headers: {} };
      const ctx = makeContext(request);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });

    it('attaches user when a valid token is provided on optional-auth routes', async () => {
      const token = jwtService.sign({
        sub: 'user-2',
        email: 'b@example.com',
      });
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${token}` },
      };
      const ctx = makeContext(request);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect((request.user as Record<string, unknown>)?.sub).toBe('user-2');
    });

    it('throws UnauthorizedException on invalid token even on optional-auth routes', async () => {
      const ctx = makeContext({
        headers: { authorization: 'Bearer invalid-token' },
      });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // Verify non-optional-auth routes are unaffected by the new code path
  it('still rejects missing header on regular (non-optional) routes', async () => {
    // Both metadata keys return false (default non-public, non-optional)
    mockReflector.getAllAndOverride.mockReturnValue(false);
    const ctx = makeContext({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });
});
