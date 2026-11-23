/**
 * Optional diagnostics for the AI interface proxy.
 *
 * The profiler is passed explicitly to `createAiManager(..., { profiler })`.
 * When absent, the proxy branches are skipped and the engine pays no
 * profiling cost. It increments plain counters only; it does not change any
 * proxy behavior or visibility semantics.
 *
 * Use it from the headless harness (`--profile-proxy` or
 * `aiProxyProfiler: true`) to decide which proxy paths are worth caching.
 */
export class AiProxyProfiler {
    constructor() {
        this.startedAt = Date.now();
        this.wrapFunctionCalls = 0;
        this.wrapFunctionCacheHits = 0;
        this.functionWrapperCreations = 0;
        this.functionProxyApplies = 0;
        this.deepWrapCalls = 0;
        this.deepWrapCacheHits = 0;
        this.deepWrapKinds = {
            primitive: 0,
            cell: 0,
            entity: 0,
            player: 0,
            gameState: 0,
            helper: 0,
            array: 0,
            function: 0,
            object: 0,
        };
        this.entitiesFilterCalls = 0;
        this.entitiesFilterCacheHits = 0;
        this.entitiesRawTotal = 0;
        this.entitiesFilteredTotal = 0;
        this.getCellsArrayCalls = 0;
        this.getCellsArrayTotal = 0;
        this.getCellsArrayCacheHits = 0;
        this.getNeighborsCalls = 0;
        this.getNeighborsCacheHits = 0;
        this.fogChecks = 0;
        this.argArrays = 0;
        this.argsTotal = 0;
        this.helperCalls = 0;
        this.helperArgArrays = 0;
        this.methodAccess = Object.create(null);
    }

    countDeepWrap(kind) {
        this.deepWrapCalls++;
        this.deepWrapKinds[kind] = (this.deepWrapKinds[kind] || 0) + 1;
    }

    countMethodAccess(prop) {
        const key = String(prop || '(anonymous)');
        this.methodAccess[key] = (this.methodAccess[key] || 0) + 1;
    }

    toJSON() {
        const methodAccess = Object.entries(this.methodAccess)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 50)
            .map(([name, count]) => ({ name, count }));
        return {
            durationMs: Date.now() - this.startedAt,
            wrapFunctionCalls: this.wrapFunctionCalls,
            wrapFunctionCacheHits: this.wrapFunctionCacheHits,
            functionWrapperCreations: this.functionWrapperCreations,
            functionProxyApplies: this.functionProxyApplies,
            deepWrapCalls: this.deepWrapCalls,
            deepWrapCacheHits: this.deepWrapCacheHits,
            deepWrapKinds: { ...this.deepWrapKinds },
            entitiesFilterCalls: this.entitiesFilterCalls,
            entitiesFilterCacheHits: this.entitiesFilterCacheHits,
            entitiesRawTotal: this.entitiesRawTotal,
            entitiesFilteredTotal: this.entitiesFilteredTotal,
            getCellsArrayCalls: this.getCellsArrayCalls,
            getCellsArrayTotal: this.getCellsArrayTotal,
            getCellsArrayCacheHits: this.getCellsArrayCacheHits,
            getNeighborsCalls: this.getNeighborsCalls,
            getNeighborsCacheHits: this.getNeighborsCacheHits,
            fogChecks: this.fogChecks,
            argArrays: this.argArrays,
            argsTotal: this.argsTotal,
            helperCalls: this.helperCalls,
            helperArgArrays: this.helperArgArrays,
            methodAccess,
        };
    }
}

export function createAiProxyProfiler() {
    return new AiProxyProfiler();
}

export default AiProxyProfiler;
