import { fail } from '../runtime/health.js';

const MAXIMUM_NODE_DEPTH = 128;
const MAXIMUM_EXPANDED_NODE_COUNT = 65_536;
const CATALOG_CACHE = new WeakMap();

function dependencyIds(compiledBase) {
  return [
    ...compiledBase.prefabInstances.map((instance) => instance.prefabId),
    ...compiledBase.prefabSlots.flatMap((slot) => slot.allowedPrefabIds),
  ];
}

function requireCompilerRegistries({ prefabRegistry, componentRegistry, resourceRegistry }) {
  if (typeof prefabRegistry?.values !== 'function' || typeof prefabRegistry?.get !== 'function'
      || typeof componentRegistry?.compile !== 'function'
      || typeof componentRegistry?.catalogEntries !== 'function'
      || typeof resourceRegistry?.validateReferences !== 'function'
      || !Number.isSafeInteger(resourceRegistry?.size)) {
    fail('display-prefab-compile-registry-invalid');
  }
}

function checkedExpandedCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_EXPANDED_NODE_COUNT) {
    fail('display-prefab-expanded-node-limit');
  }
  return value;
}

function ownDepths(compiledBase) {
  const depths = new Map([[null, 1]]);
  let maximum = 1;
  for (const node of compiledBase.nodes) {
    const parentDepth = depths.get(node.parentLocalPath);
    if (parentDepth === undefined) fail('display-prefab-instance-parent-missing');
    const depth = parentDepth + 1;
    depths.set(node.localPath, depth);
    maximum = Math.max(maximum, depth);
  }
  return { depths, maximum };
}

function addStaticPath(paths, path) {
  if (paths.has(path)) fail('display-prefab-instance-key-duplicate');
  paths.add(path);
}

function validatePathNamespaces(staticPaths, dynamicPrefixes) {
  if (new Set(dynamicPrefixes).size !== dynamicPrefixes.length) {
    fail('display-prefab-instance-key-duplicate');
  }
  for (const prefix of dynamicPrefixes) {
    for (const path of staticPaths) {
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        fail('display-prefab-instance-key-duplicate');
      }
    }
  }
}

function cachedCatalog(prefabRegistry, componentRegistry, resourceRegistry, signature) {
  const byComponent = CATALOG_CACHE.get(prefabRegistry);
  const byResource = byComponent?.get(componentRegistry);
  const cached = byResource?.get(resourceRegistry);
  return cached?.signature === signature ? cached.catalog : null;
}

function storeCatalog(prefabRegistry, componentRegistry, resourceRegistry, signature, catalog) {
  let byComponent = CATALOG_CACHE.get(prefabRegistry);
  if (!byComponent) {
    byComponent = new WeakMap();
    CATALOG_CACHE.set(prefabRegistry, byComponent);
  }
  let byResource = byComponent.get(componentRegistry);
  if (!byResource) {
    byResource = new WeakMap();
    byComponent.set(componentRegistry, byResource);
  }
  byResource.set(resourceRegistry, Object.freeze({ signature, catalog }));
}

/**
 * Compile one complete Prefab dependency graph. The returned accessor is private to
 * DisplayRuntime; compiled definitions still materialize into the sole Node graph.
 */
export function compilePrefabCatalog({ prefabRegistry, componentRegistry, resourceRegistry }) {
  requireCompilerRegistries({ prefabRegistry, componentRegistry, resourceRegistry });
  const definitions = [...prefabRegistry.values()];
  const signature = `${definitions.length}:${componentRegistry.catalogEntries().length}:${resourceRegistry.size}`;
  const cached = cachedCatalog(prefabRegistry, componentRegistry, resourceRegistry, signature);
  if (cached !== null) return cached;
  resourceRegistry.validateReferences();

  const bases = new Map();
  for (const definition of definitions) {
    if (typeof definition?._compileBase !== 'function') fail('display-definition-invalid');
    const base = definition._compileBase({
      componentRegistry,
      resourceRegistry,
      validateResourceReferences: false,
    });
    bases.set(definition.id, base);
  }

  for (const base of bases.values()) {
    for (const prefabId of dependencyIds(base)) {
      if (prefabRegistry.get(prefabId) === null) fail('display-prefab-missing');
    }
  }

  const visitState = new Map();
  const visit = (prefabId, depth = 1) => {
    if (depth > MAXIMUM_NODE_DEPTH) fail('display-node-depth-limit');
    const state = visitState.get(prefabId) ?? 0;
    if (state === 1) fail('display-prefab-cycle');
    if (state === 2) return;
    visitState.set(prefabId, 1);
    for (const dependencyId of dependencyIds(bases.get(prefabId))) visit(dependencyId, depth + 1);
    visitState.set(prefabId, 2);
  };
  for (const prefabId of bases.keys()) visit(prefabId);

  const compiledById = new Map();
  const build = (prefabId) => {
    const existing = compiledById.get(prefabId);
    if (existing) return existing;
    const base = bases.get(prefabId);
    const prefabInstances = base.prefabInstances.map((instance) => {
      const definition = prefabRegistry.get(instance.prefabId);
      return Object.freeze({
        ...instance,
        definition,
        compiledPrefab: build(instance.prefabId),
      });
    });
    const prefabSlots = base.prefabSlots.map((slot) => Object.freeze({
      ...slot,
      allowedPrefabs: Object.freeze(slot.allowedPrefabIds.map((allowedPrefabId) => {
        const definition = prefabRegistry.get(allowedPrefabId);
        return Object.freeze({
          prefabId: allowedPrefabId,
          definition,
          compiledPrefab: build(allowedPrefabId),
        });
      })),
    }));

    const staticPaths = new Set();
    for (const node of base.nodes) addStaticPath(staticPaths, node.localPath);
    const dynamicPrefixes = prefabSlots.map((slot) => slot.key);
    for (const instance of prefabInstances) {
      addStaticPath(staticPaths, instance.key);
      for (const childPath of instance.compiledPrefab.expandedStaticLocalPaths) {
        addStaticPath(staticPaths, `${instance.key}/${childPath}`);
      }
      for (const childPrefix of instance.compiledPrefab.dynamicInstancePrefixes) {
        dynamicPrefixes.push(`${instance.key}/${childPrefix}`);
      }
    }
    validatePathNamespaces(staticPaths, dynamicPrefixes);

    const { depths, maximum: ownMaximumDepth } = ownDepths(base);
    let maximumGraphHeight = ownMaximumDepth;
    let maximumExpandedNodeCount = checkedExpandedCount(1 + base.nodes.length);
    for (const instance of prefabInstances) {
      const mountDepth = depths.get(instance.parentLocalPath);
      maximumGraphHeight = Math.max(maximumGraphHeight,
        mountDepth + instance.compiledPrefab.maximumGraphHeight);
      maximumExpandedNodeCount = checkedExpandedCount(
        maximumExpandedNodeCount + instance.compiledPrefab.maximumExpandedNodeCount,
      );
    }
    for (const slot of prefabSlots) {
      const mountDepth = depths.get(slot.parentLocalPath);
      const largestChildCount = Math.max(...slot.allowedPrefabs.map(
        (entry) => entry.compiledPrefab.maximumExpandedNodeCount,
      ));
      const largestChildHeight = Math.max(...slot.allowedPrefabs.map(
        (entry) => entry.compiledPrefab.maximumGraphHeight,
      ));
      maximumGraphHeight = Math.max(maximumGraphHeight, mountDepth + largestChildHeight);
      maximumExpandedNodeCount = checkedExpandedCount(maximumExpandedNodeCount
        + slot.maximumInstances * largestChildCount);
    }
    if (maximumGraphHeight > MAXIMUM_NODE_DEPTH) fail('display-node-depth-limit');

    const compiled = Object.freeze({
      ...base,
      prefabInstances: Object.freeze(prefabInstances),
      prefabSlots: Object.freeze(prefabSlots),
      expandedStaticLocalPaths: Object.freeze([...staticPaths].sort()),
      dynamicInstancePrefixes: Object.freeze([...dynamicPrefixes].sort()),
      maximumGraphHeight,
      maximumExpandedNodeCount,
    });
    compiledById.set(prefabId, compiled);
    return compiled;
  };
  for (const prefabId of bases.keys()) build(prefabId);

  const ordered = Object.freeze([...compiledById.values()]
    .sort((left, right) => left.id.localeCompare(right.id)));
  const catalog = Object.freeze({
    size: ordered.length,
    get(prefabId) {
      const definition = prefabRegistry.get(prefabId);
      return definition === null ? null : compiledById.get(definition.id) ?? null;
    },
    require(prefabId) {
      const result = this.get(prefabId);
      if (result === null) fail('display-prefab-missing');
      return result;
    },
    values() { return ordered.values(); },
  });
  storeCatalog(prefabRegistry, componentRegistry, resourceRegistry, signature, catalog);
  return catalog;
}
