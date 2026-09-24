// Config commune à toutes les extensions Pulse Suite — garder ce fichier identique d'un repo à
// l'autre (seul le tableau `files` varie si le repo a des .tsx ou un dossier test/).
// Voir HARMONISATION.md, phase 1.
const js = require('@eslint/js');
const tseslintPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const simpleImportSort = require('eslint-plugin-simple-import-sort');

module.exports = [
  {
    // media/ contient du JS navigateur écrit à la main, hors périmètre du parser TS.
    ignores: ['dist/**', 'out/**', 'node_modules/**', 'media/**', 'provisioning/**'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        // Lint type-aware (no-floating-promises) : le tsconfig racine inclut déjà
        // src/**/*.ts et test/**/*.ts, donc src/core, src/cli, src/extension et
        // src/shims sont tous couverts par un seul projet.
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslintPlugin,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      ...js.configs.recommended.rules,
      // Désactive les règles de base que TypeScript vérifie déjà (no-undef en premier lieu :
      // sans ça, chaque require/console/__dirname serait signalé, la flat config ne définissant
      // aucun global par elle-même).
      ...tseslintPlugin.configs['flat/eslint-recommended'].rules,
      ...tseslintPlugin.configs.recommended.rules,
      // ignoreRestSiblings couvre l'idiome `const { secret: _s, ...rest } = obj` utilisé pour
      // retirer une clé : la variable extraite est volontairement inutilisée.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/consistent-type-imports': 'warn',
      'simple-import-sort/imports': 'warn',
      'simple-import-sort/exports': 'warn',
      // Le modificateur `private` de TypeScript porte déjà l'information ; le préfixe `_` est
      // redondant (décision HARMONISATION.md, phase 1b). Ne touche pas au `_` sur les paramètres
      // ignorés (no-unused-vars ci-dessus), qui est un idiome différent.
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: ['classProperty', 'classMethod', 'accessor', 'parameterProperty'],
          modifiers: ['private'],
          // UPPER_CASE stays allowed: this only bans the leading underscore, it
          // isn't meant to relitigate the separate convention for constants.
          format: ['camelCase', 'UPPER_CASE'],
          leadingUnderscore: 'forbid',
        },
      ],
      // Type-aware : seuls les rejets non gérés nous intéressent ici, jamais un `await` réécrit —
      // ce repo mesure justement latence (P2) et concurrence (P3), un changement de timing y est
      // particulièrement indésirable. Les fire-and-forget légitimes sont marqués `void`.
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
];
