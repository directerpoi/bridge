module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: 'coverage',
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        lib: ['ES2022'],
        types: ['node', 'jest'],
        isolatedModules: true,
        esModuleInterop: true,
        strict: true,
      },
    }],
  },
};
