/**
 * adjustedView — a twist-adjusted view of a manifest entity definition.
 *
 * AI code often reads an entity's numbers from its manifest meta (spawnCost,
 * yields, damage, armor, attackCostScale). This returns a COPY of the meta
 * with those fields overlaid from the owning player's Player functions
 * (getSpawnCost, getMaintenanceCost, getYields, getAttackCost,
 * getAttackValue, getArmorValue), so the AI sees the real, twist-adjusted
 * numbers. All other fields (movement, buildables, score, sightRange, …)
 * pass through unchanged, and the manifest is never mutated.
 *
 * The adjustment multipliers live ONLY in the Player class; this is a thin
 * adapter, not a second implementation — it computes nothing itself.
 *
 * A foreign player's twists are hidden by the proxy (its value functions
 * return undefined), so an enemy is viewed at the raw manifest values —
 * the AI cannot learn another leader's twists.
 *
 * @param {Object} player - the owning (proxied) player whose twists apply.
 *   Must expose the Player value functions (via the proxy allow-list).
 * @param {Object} meta - the raw manifest entity definition (or null).
 * @param {string} name - the entity type name.
 * @returns {Object|null} adjusted copy, or null when meta is null.
 */
export function adjustedView(player, meta, name) {
  if (!meta) return null;
  if (!player || typeof player.getAttackValue !== 'function') return { ...meta };
  // A foreign player (or any player whose value functions the proxy hides)
  // answers with undefined — fall back to the raw manifest values.
  const attack = player.getAttackValue(name);
  if (!attack || typeof attack.value !== 'number') return { ...meta };
  return {
    ...meta,
    spawnCost: player.getSpawnCost(name) || meta.spawnCost,
    maintenance: player.getMaintenanceCost(name) || meta.maintenance,
    yields: player.getYields(name) || meta.yields,
    attackCostScale: player.getAttackCost(name) ?? meta.attackCostScale,
    damage: meta.damage
      ? { ...meta.damage, value: attack.value, type: attack.type }
      : undefined,
    armor: player.getArmorValue(name) || meta.armor,
  };
}
