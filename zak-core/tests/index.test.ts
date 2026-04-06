import { greeting } from '../src/index';

describe('greeting', () => {
  it('should return a greeting message', () => {
    expect(greeting('Zak')).toBe('Hello, Zak! Welcome to zak-core.');
  });
});

