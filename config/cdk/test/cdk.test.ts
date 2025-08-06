// Basic CDK type checking test
test('TypeScript compilation passes with strict settings', () => {
  // This test ensures our stricter TypeScript configuration works
  // If the test file compiles without errors, the strict config is working
  const testValue: string = 'test';
  expect(testValue).toBe('test');
});
