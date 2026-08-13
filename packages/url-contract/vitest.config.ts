import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
		exclude: ['src/**/__tests__/bench.bench.ts', 'node_modules', 'dist'],
	},
});
