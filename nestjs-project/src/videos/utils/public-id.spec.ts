import { generatePublicId } from './public-id';

describe('generatePublicId', () => {
  it('should return a 12-character string', () => {
    const id = generatePublicId();
    expect(id).toHaveLength(12);
  });

  it('should contain only base64url characters [A-Za-z0-9_-]', () => {
    const id = generatePublicId();
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('should generate unique values across calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generatePublicId()));
    expect(ids.size).toBe(100);
  });
});
