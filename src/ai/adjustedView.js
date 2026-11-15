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
 * This form is for the ACTING player's catalog/buildable types (and for a
 * type whose owner is the acting player). A foreign *player* object hides
 * its value functions through the proxy, so passing a foreign owner here
 * yields the raw manifest values.
 *
 * For a VISIBLE ENTITY INSTANCE — including another player's — use
 * `adjustedEntityView(entity, meta)` below instead: the entity's own
 * methods run with the real owner, so yields/costs/attack/armor are the
 * adjusted, public values. Only the owner's total empire resource profile
 * stays private.
 *
 * @param {Object} player - the acting/owning (proxied) player whose twists apply.
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

/**
 * Adjusted view of a VISIBLE entity instance, including other players'
 * entities. Entity methods run on the real entity (the AI proxy binds them
 * to the target), so the real owner's twists apply even though the foreign
 * *player* object hides its value functions. Only the empire resource
 * profile remains private.
 *
 * Use this for entity instances; use `adjustedView(player, meta, name)` for
 * the acting player's buildable catalog.
 *
 * @param {Object} entity - the (possibly proxied) visible entity.
 * @param {Object} meta - the raw manifest entity definition (or null).
 * @returns {Object|null} adjusted copy, or null when meta is null.
 */
export function adjustedEntityView(entity, meta) {
  if (!meta) return null;
  return {
    ...meta,
    spawnCost: entity.getCostToSpawn(),
    maintenance: entity.getCostToMaintain(),
    yields: entity.yields,
    attackCostScale: entity.getAttackCost(),
    damage: meta.damage ? { ...meta.damage, ...entity.getAttackValue() } : entity.getAttackValue(),
    armor: entity.getArmorValue(),
  };
}
