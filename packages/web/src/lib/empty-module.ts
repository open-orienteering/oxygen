// Empty module stub — used as a Vite alias for Node-only modules (like 'fs')
// that are required by browser-compatible libraries but never actually invoked.
export default {};
export const readFile = () => { throw new Error("fs.readFile is not available in the browser"); };
