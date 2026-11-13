import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ProxyError,
  ValidationError,
  TransformError,
  UpstreamError,
  ConfigurationError,
  NotSupportedError,
  UnsupportedParameterError,
} from './errors';

describe('errors', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe('ProxyError', () => {
    it('should have correct defaults', () => {
      const error = new ProxyError('Something went wrong');
      expect(error.message).toBe('Something went wrong');
      expect(error.statusCode).toBe(500);
      expect(error.code).toBe('PROXY_ERROR');
      expect(error.name).toBe('ProxyError');
    });

    it('should accept custom status and code', () => {
      const error = new ProxyError('Custom error', 418, 'TEAPOT');
      expect(error.statusCode).toBe(418);
      expect(error.code).toBe('TEAPOT');
    });

    it('should serialize to JSON with context in development', () => {
      process.env.NODE_ENV = 'development';
      const error = new ProxyError('Test', 500, 'TEST', { foo: 'bar' });
      const json = error.toJSON();
      expect(json.error.details).toEqual({ foo: 'bar' });
    });

    it('should hide context in production', () => {
      process.env.NODE_ENV = 'production';
      const error = new ProxyError('Test', 500, 'TEST', { foo: 'bar' });
      const json = error.toJSON();
      expect(json.error.details).toBeUndefined();
    });
  });

  describe('ValidationError', () => {
    it('should have 400 status', () => {
      const error = new ValidationError('Invalid input');
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('TransformError', () => {
    it('should have 500 status', () => {
      const error = new TransformError('Transform failed');
      expect(error.statusCode).toBe(500);
      expect(error.code).toBe('TRANSFORM_ERROR');
    });
  });

  describe('UpstreamError', () => {
    it('should have 502 status and include upstream info', () => {
      const error = new UpstreamError('API failed', 429, { error: 'rate limited' });
      expect(error.statusCode).toBe(502);
      expect(error.code).toBe('UPSTREAM_ERROR');
      expect(error.upstreamStatus).toBe(429);
      expect(error.upstreamBody).toEqual({ error: 'rate limited' });
    });
  });

  describe('UnsupportedParameterError', () => {
    it('should carry code and param on the canonical error', () => {
      expect(new UnsupportedParameterError('store', 'm').toCanonical()).toEqual({
        kind: 'invalid_request',
        status: 400,
        message: 'm',
        code: 'unsupported_parameter',
        param: 'store',
      });
    });
  });

  describe('NotSupportedError', () => {
    it('should have 501 status and map to unsupported kind', () => {
      const error = new NotSupportedError('nope');
      expect(error.statusCode).toBe(501);
      expect(error.code).toBe('NOT_SUPPORTED');
      expect(error.toCanonical()).toEqual({
        kind: 'unsupported',
        status: 501,
        message: 'nope',
      });
    });
  });

  describe('ConfigurationError', () => {
    it('should have 500 status', () => {
      const error = new ConfigurationError('Missing API key');
      expect(error.statusCode).toBe(500);
      expect(error.code).toBe('CONFIGURATION_ERROR');
    });
  });
});
