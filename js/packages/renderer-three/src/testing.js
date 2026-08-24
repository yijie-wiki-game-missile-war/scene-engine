// Deliberately outside the package export map. This adapter entry is only for
// deterministic Node tests; production construction always owns real Three.
export { createThreeRenderRuntimeForTest } from './runtime.js';
