/**
 * File: src/core/LoadBalancer.js
 * Description: High-concurrency load balancer with batch rotation, sticky sessions,
 * round-robin, circuit breaking (429 rest), and automatic failover.
 *
 * Batch system: accounts are divided into batches. When a configurable ratio of a
 * batch's slots are resting (429), the system auto-rotates to the next batch.
 */

class AccountSlot {
    constructor(authIndex) {
        this.authIndex = authIndex;
        this.restingUntil = null;
    }

    isHealthy() {
        if (!this.restingUntil) return true;
        if (Date.now() > this.restingUntil.getTime()) {
            this.restingUntil = null;
            return true;
        }
        return false;
    }

    markResting(durationMs) {
        this.restingUntil = new Date(Date.now() + durationMs);
    }

    getRestingRemainingSeconds() {
        if (!this.restingUntil) return 0;
        const remaining = this.restingUntil.getTime() - Date.now();
        return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    }
}

class StickyInfo {
    constructor(slotIndex, requestCount = 0) {
        this.slotIndex = slotIndex;
        this.requestCount = requestCount;
        this.lastUsed = Date.now();
    }
}

/**
 * LoadBalancer - Distributes requests across account slots with:
 * 1. Batch rotation: divide accounts into batches, rotate when threshold of 429s hit
 * 2. Sticky sessions: same client IP reuses same slot for N requests
 * 3. Round-robin: after sticky threshold, rotate to next healthy slot in batch
 * 4. Circuit breaking: 429-marked slots rest for configurable duration
 * 5. In-request failover: retry on next healthy slot when current returns 429
 */
class LoadBalancer {
    constructor(logger, config, connectionRegistry) {
        this.logger = logger;
        this.config = config;
        this.connectionRegistry = connectionRegistry;

        /** @type {AccountSlot[]} */
        this.slots = [];

        /** @type {Map<string, StickyInfo>} */
        this.stickyMap = new Map();

        /** @type {Map<number, number>} Retired auth indices -> retirement timestamp (429'd) */
        this.retiredMap = new Map();

        /** @type {number} */
        this.nextIndex = 0;

        // Core configuration
        this.stickyThreshold = parseInt(process.env.STICKY_THRESHOLD, 10) || 10;
        this.restDurationMs = (parseInt(process.env.REST_DURATION_MINUTES, 10) || 1) * 60 * 1000;

        // Batch configuration
        this.batchSize = parseInt(process.env.POOL_BATCH_SIZE, 10) || 0; // 0 = no batching
        this.batchSwitchRatio = parseFloat(process.env.POOL_BATCH_SWITCH_RATIO) || 0.5;
        this.currentBatchIndex = 0;

        // Retirement recovery configuration (default 5 hours)
        this.retireRecoveryMs = (parseFloat(process.env.RETIRE_RECOVERY_HOURS) || 5) * 60 * 60 * 1000;

        this._cleanupInterval = setInterval(() => this._cleanupStickyMap(), 10 * 60 * 1000);
    }

    // ─── Batch helpers ───

    get totalBatches() {
        if (this.batchSize <= 0 || this.slots.length === 0) return 1;
        return Math.ceil(this.slots.length / this.batchSize);
    }

    _getBatchRange(batchIndex) {
        if (this.batchSize <= 0) return { end: this.slots.length, start: 0 };
        const start = batchIndex * this.batchSize;
        const end = Math.min(start + this.batchSize, this.slots.length);
        return { end, start };
    }

    _isInActiveBatch(slotIndex) {
        if (this.batchSize <= 0) return true;
        const { start, end } = this._getBatchRange(this.currentBatchIndex);
        return slotIndex >= start && slotIndex < end;
    }

    /**
     * Check if the current batch needs rotation (called after markSlotResting)
     */
    _checkBatchRotation() {
        if (this.batchSize <= 0 || this.totalBatches <= 1) return;

        const { start, end } = this._getBatchRange(this.currentBatchIndex);
        const batchSlots = this.slots.slice(start, end);
        if (batchSlots.length === 0) return;

        const restingCount = batchSlots.filter(s => !s.isHealthy()).length;
        const ratio = restingCount / batchSlots.length;

        if (ratio >= this.batchSwitchRatio) {
            const nextBatch = (this.currentBatchIndex + 1) % this.totalBatches;
            this.logger.info(
                `[LoadBalancer] 🔄 Batch rotation: batch #${this.currentBatchIndex} has ` +
                    `${restingCount}/${batchSlots.length} resting (${(ratio * 100).toFixed(0)}% >= ` +
                    `${(this.batchSwitchRatio * 100).toFixed(0)}%), switching to batch #${nextBatch}`
            );
            this.currentBatchIndex = nextBatch;
            const newRange = this._getBatchRange(nextBatch);
            this.nextIndex = newRange.start;
            this.stickyMap.clear();
        }
    }

    // ─── Pool management ───

    updatePool(authIndices) {
        const existingMap = new Map(this.slots.map(s => [s.authIndex, s]));
        const newSlots = [];
        for (const idx of authIndices) {
            // Skip retired accounts when rebuilding pool
            if (this.retiredMap.has(idx)) continue;
            newSlots.push(existingMap.has(idx) ? existingMap.get(idx) : new AccountSlot(idx));
        }
        this.slots = newSlots;

        // Clean stale sticky entries
        const activeSet = new Set(this.slots.map(s => s.authIndex));
        for (const [ip, info] of this.stickyMap.entries()) {
            if (info.slotIndex >= this.slots.length || !activeSet.has(this.slots[info.slotIndex]?.authIndex)) {
                this.stickyMap.delete(ip);
            }
        }
        if (this.nextIndex >= this.slots.length) this.nextIndex = 0;
        if (this.currentBatchIndex >= this.totalBatches) this.currentBatchIndex = 0;

        const batchInfo =
            this.batchSize > 0
                ? `, batch size: ${this.batchSize}, batches: ${this.totalBatches}, switch ratio: ${(this.batchSwitchRatio * 100).toFixed(0)}%`
                : ", batching: disabled";
        this.logger.info(
            `[LoadBalancer] Pool updated: ${this.slots.length} slots [${this.slots.map(s => s.authIndex).join(", ")}], ` +
                `retired: ${this.retiredMap.size}, sticky: ${this.stickyThreshold}, rest: ${this.restDurationMs / 1000}s${batchInfo}`
        );
    }

    addSlot(authIndex) {
        if (this.slots.some(s => s.authIndex === authIndex)) return;
        this.slots.push(new AccountSlot(authIndex));
        this.logger.info(`[LoadBalancer] Added slot for account #${authIndex}, total: ${this.slots.length}`);
    }

    removeSlot(authIndex) {
        const idx = this.slots.findIndex(s => s.authIndex === authIndex);
        if (idx === -1) return;
        this.slots.splice(idx, 1);
        // Adjust sticky session indices after removal
        for (const [ip, info] of this.stickyMap.entries()) {
            if (info.slotIndex === idx) {
                this.stickyMap.delete(ip);
            } else if (info.slotIndex > idx) {
                info.slotIndex--;
            }
        }
        if (this.nextIndex >= this.slots.length) this.nextIndex = 0;
        if (this.currentBatchIndex >= this.totalBatches) this.currentBatchIndex = 0;
        this.logger.info(`[LoadBalancer] Removed slot for account #${authIndex}, total: ${this.slots.length}`);
    }

    /**
     * Permanently retire a slot (429 rate-limited).
     * The account is removed from the active pool and tracked in retiredMap.
     * A reserve account should be swapped in to replace it.
     * @param {number} authIndex
     */
    retireSlot(authIndex) {
        const idx = this.slots.findIndex(s => s.authIndex === authIndex);
        if (idx === -1) {
            // Not in active pool, just add to retired map
            this.retiredMap.set(authIndex, Date.now());
            return;
        }

        this.slots.splice(idx, 1);
        this.retiredMap.set(authIndex, Date.now());

        // Adjust sticky session indices after removal
        for (const [ip, info] of this.stickyMap.entries()) {
            if (info.slotIndex === idx) {
                this.stickyMap.delete(ip);
            } else if (info.slotIndex > idx) {
                info.slotIndex--;
            }
        }

        if (this.nextIndex >= this.slots.length) this.nextIndex = 0;
        if (this.currentBatchIndex >= this.totalBatches) this.currentBatchIndex = 0;

        const recoveryHours = (this.retireRecoveryMs / 3600000).toFixed(1);
        this.logger.info(
            `[LoadBalancer] ⛔ Account #${authIndex} RETIRED (429), removed from pool. ` +
                `Active: ${this.slots.length}, Retired: ${this.retiredMap.size}. ` +
                `Will auto-recover in ${recoveryHours}h.`
        );
    }

    /**
     * Check if an account is retired
     * @param {number} authIndex
     * @returns {boolean}
     */
    isRetired(authIndex) {
        return this.retiredMap.has(authIndex);
    }

    /**
     * Get reserve auth indices (available but not active and not retired)
     * @param {number[]} allAuthIndices - All available auth indices from AuthSource
     * @returns {number[]}
     */
    getReserveIndices(allAuthIndices) {
        const activeSet = new Set(this.slots.map(s => s.authIndex));
        return allAuthIndices.filter(idx => !activeSet.has(idx) && !this.retiredMap.has(idx));
    }

    /**
     * Get retired accounts that are ready for recovery (past retireRecoveryMs)
     * @returns {number[]} auth indices eligible for recovery
     */
    getRecoverableIndices() {
        const now = Date.now();
        const recoverable = [];
        for (const [authIndex, retiredAt] of this.retiredMap.entries()) {
            if (now - retiredAt >= this.retireRecoveryMs) {
                recoverable.push(authIndex);
            }
        }
        return recoverable;
    }

    /**
     * Remove an account from retired state (recovery)
     * @param {number} authIndex
     */
    unretire(authIndex) {
        this.retiredMap.delete(authIndex);
        this.logger.info(
            `[LoadBalancer] ♻️ Account #${authIndex} UNRETIRED, eligible for pool re-entry. ` +
                `Remaining retired: ${this.retiredMap.size}`
        );
    }

    // ─── Slot selection ───

    /**
     * Find next healthy slot via round-robin within a specific batch
     * @returns {{ authIndex: number, slotIndex: number } | null}
     */
    _roundRobinInBatch(batchIndex) {
        const { start, end } = this._getBatchRange(batchIndex);
        const batchLen = end - start;
        if (batchLen <= 0) return null;

        let rr = this.nextIndex;
        if (rr < start || rr >= end) rr = start;

        for (let i = 0; i < batchLen; i++) {
            const idx = start + ((rr - start + i) % batchLen);
            const slot = this.slots[idx];
            if (slot.isHealthy() && this._hasConnection(slot.authIndex)) {
                this.nextIndex = start + ((idx - start + 1) % batchLen);
                return { authIndex: slot.authIndex, slotIndex: idx };
            }
        }
        return null;
    }

    /**
     * Select the best slot for a request (main entry point)
     * @param {string} clientIP
     * @returns {{ authIndex: number, slotIndex: number } | null}
     */
    selectSlot(clientIP) {
        if (this.slots.length === 0) return null;

        // 1. Sticky session check (must be in active batch)
        const sticky = this.stickyMap.get(clientIP);
        if (sticky && sticky.requestCount < this.stickyThreshold) {
            const slot = this.slots[sticky.slotIndex];
            if (
                slot &&
                slot.isHealthy() &&
                this._isInActiveBatch(sticky.slotIndex) &&
                this._hasConnection(slot.authIndex)
            ) {
                sticky.requestCount++;
                sticky.lastUsed = Date.now();
                this.logger.debug(
                    `[LoadBalancer] Sticky hit: IP=${clientIP} -> account #${slot.authIndex} ` +
                        `(${sticky.requestCount}/${this.stickyThreshold})`
                );
                return { authIndex: slot.authIndex, slotIndex: sticky.slotIndex };
            }
            this.stickyMap.delete(clientIP);
        } else if (sticky) {
            this.stickyMap.delete(clientIP);
        }

        // 2. Round-robin in current batch
        const result = this._roundRobinInBatch(this.currentBatchIndex);
        if (result) {
            this.stickyMap.set(clientIP, new StickyInfo(result.slotIndex, 1));
            this.logger.debug(
                `[LoadBalancer] Round-robin: IP=${clientIP} -> account #${result.authIndex} ` +
                    `(batch #${this.currentBatchIndex})`
            );
            return result;
        }

        // 3. Current batch exhausted — try other batches
        if (this.totalBatches > 1) {
            for (let b = 1; b < this.totalBatches; b++) {
                const nextBatch = (this.currentBatchIndex + b) % this.totalBatches;
                const alt = this._roundRobinInBatch(nextBatch);
                if (alt) {
                    this.logger.info(
                        `[LoadBalancer] Batch #${this.currentBatchIndex} exhausted, failover to batch #${nextBatch}`
                    );
                    this.currentBatchIndex = nextBatch;
                    this.stickyMap.clear();
                    this.stickyMap.set(clientIP, new StickyInfo(alt.slotIndex, 1));
                    return alt;
                }
            }
        }

        // 4. All exhausted
        this.logger.warn("[LoadBalancer] All slots across all batches are resting or disconnected!");
        return null;
    }

    /**
     * Select next healthy slot for in-request retry (excludes already-tried slots)
     * Searches current batch first, then other batches.
     * @param {number} currentAuthIndex
     * @param {Set<number>} [skipAuthIndices]
     * @returns {{ authIndex: number, slotIndex: number } | null}
     */
    selectNextSlot(currentAuthIndex, skipAuthIndices = new Set()) {
        // Try current batch first, then rotate through others
        for (let b = 0; b < this.totalBatches; b++) {
            const batchIdx = (this.currentBatchIndex + b) % this.totalBatches;
            const { start, end } = this._getBatchRange(batchIdx);
            for (let idx = start; idx < end; idx++) {
                const slot = this.slots[idx];
                if (slot.authIndex === currentAuthIndex) continue;
                if (skipAuthIndices.has(slot.authIndex)) continue;
                if (!slot.isHealthy()) continue;
                if (!this._hasConnection(slot.authIndex)) continue;

                // If found in a different batch, switch to it
                if (batchIdx !== this.currentBatchIndex) {
                    this.logger.info(`[LoadBalancer] Retry failover: switching to batch #${batchIdx}`);
                    this.currentBatchIndex = batchIdx;
                    this.stickyMap.clear();
                }
                return { authIndex: slot.authIndex, slotIndex: idx };
            }
        }
        return null;
    }

    // ─── Circuit breaker ───

    /**
     * Mark a slot as resting (429 circuit breaker)
     * Clears sticky sessions and checks batch rotation
     */
    markSlotResting(authIndex) {
        const slot = this.slots.find(s => s.authIndex === authIndex);
        if (!slot) return;

        slot.markResting(this.restDurationMs);
        this.logger.info(
            `[LoadBalancer] ⚡ Account #${authIndex} marked RESTING for ${this.restDurationMs / 1000}s ` +
                `(until ${slot.restingUntil.toISOString()})`
        );

        // Clear sticky sessions pointing to this slot
        const slotIdx = this.slots.indexOf(slot);
        for (const [ip, info] of this.stickyMap.entries()) {
            if (info.slotIndex === slotIdx) this.stickyMap.delete(ip);
        }

        // Check if batch rotation is needed
        this._checkBatchRotation();
    }

    markSlotHealthy(authIndex) {
        const slot = this.slots.find(s => s.authIndex === authIndex);
        if (slot) {
            slot.restingUntil = null;
            this.logger.info(`[LoadBalancer] Account #${authIndex} manually marked HEALTHY`);
        }
    }

    // ─── Monitoring ───

    getPoolStatus() {
        const activeSlots = this.slots.map((slot, idx) => ({
            authIndex: slot.authIndex,
            batch: this.batchSize > 0 ? Math.floor(idx / this.batchSize) : 0,
            connected: this._hasConnection(slot.authIndex),
            healthy: slot.isHealthy(),
            isActiveBatch: this._isInActiveBatch(idx),
            restingRemaining: slot.getRestingRemainingSeconds(),
            restingUntil: slot.restingUntil ? slot.restingUntil.toISOString() : null,
            status: "active",
        }));

        // Include retired accounts in status with recovery timing
        const now = Date.now();
        const retiredSlots = [...this.retiredMap.entries()].map(([authIndex, retiredAt]) => {
            const elapsed = now - retiredAt;
            const remainingMs = Math.max(0, this.retireRecoveryMs - elapsed);
            return {
                authIndex,
                batch: null,
                connected: false,
                healthy: false,
                isActiveBatch: false,
                recoveryRemainingMinutes: Math.ceil(remainingMs / 60000),
                retiredAt: new Date(retiredAt).toISOString(),
                status: "retired",
            };
        });

        return [...activeSlots, ...retiredSlots];
    }

    getPoolStats() {
        let healthy = 0,
            resting = 0,
            disconnected = 0;
        const { start, end } = this._getBatchRange(this.currentBatchIndex);

        for (const slot of this.slots) {
            if (!slot.isHealthy()) resting++;
            else if (!this._hasConnection(slot.authIndex)) disconnected++;
            else healthy++;
        }

        // Active batch stats
        let batchHealthy = 0,
            batchResting = 0;
        for (let i = start; i < end; i++) {
            const s = this.slots[i];
            if (!s) continue;
            if (!s.isHealthy()) batchResting++;
            else if (this._hasConnection(s.authIndex)) batchHealthy++;
        }

        return {
            activeBatch: this.currentBatchIndex,
            batchHealthy,
            batchResting,
            batchSize: this.batchSize > 0 ? Math.min(this.batchSize, end - start) : this.slots.length,
            disconnected,
            healthy,
            resting,
            retired: this.retiredMap.size,
            total: this.slots.length,
            totalBatches: this.totalBatches,
        };
    }

    _hasConnection(authIndex) {
        const conn = this.connectionRegistry.getConnectionByAuth(authIndex, false);
        return conn && conn.readyState === 1;
    }

    _cleanupStickyMap() {
        if (this.stickyMap.size > 10000) {
            this.stickyMap.clear();
            return;
        }
        const cutoff = Date.now() - 30 * 60 * 1000;
        for (const [ip, info] of this.stickyMap.entries()) {
            if (info.lastUsed < cutoff) this.stickyMap.delete(ip);
        }
    }

    destroy() {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
        this.stickyMap.clear();
        this.retiredMap.clear();
    }
}

module.exports = LoadBalancer;
