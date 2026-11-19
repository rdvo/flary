// Wrangler imports .sql files as strings by default.
declare module '*.sql' {
  const text: string;
  export default text;
}
