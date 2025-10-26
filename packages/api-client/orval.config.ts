import { defineConfig } from 'orval';

export default defineConfig({
  semiont: {
    input: './openapi.json',
    output: {
      mode: 'tags-split',
      target: 'src/client/endpoints.ts',
      schemas: 'src/client/models',
      client: 'ky',
      clean: true,
      prettier: true,
      override: {
        mutator: {
          path: './src/client/custom-instance.ts',
          name: 'customInstance'
        }
      }
    },
  },
});
