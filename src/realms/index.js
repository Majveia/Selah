// Realm registry: name → lazy loader. Each module default-exports a class extending core/realm.js.
export const REALMS = {
  web: () => import('./web/index.js'),             // the cosmic web — structure formation
  galaxy: () => import('./galaxy/index.js'),       // a single galaxy
  blackhole: () => import('./blackhole/index.js'), // gravitational lensing around a black hole
  system: () => import('./system/index.js'),       // a star and its worlds
  orbit: () => import('./orbit/index.js'),         // a planet from orbit
  surface: () => import('./surface/index.js'),     // walking / riding on a world
};
