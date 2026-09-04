Examine the AI manager implemetations in ai/standard - but don't copy the implementation as they are all flawed.
Create a new manager like ai/standard/manager.js that implements processTurn(). The goal is to maximize the player score as quickly as possible. Do not hardcode actions, numbers, or unit names - these can all be modified in the settings and manifest, and this AI should work with ANY settings and configuration. Use the ai/utils.js functions as needed - don't duplicate functionality.

GUIDELINES:

1. The score provided by each units is defined in the entity definition in the manifest. In addition to that, there is an "exploratrion" score based on number of visible and explored cells.
2. Entities have resource costs to build and maintain, and produce resources each turn - all defined in the entity definition in the manifest
3. If a player doesn't have enough resources to pay for entity maintenance cost, that entity can not be used to perform actions and does not yield any resources
4. Make sure the AI does not get stuck - if it lacks enough resources it MUST build entities to produce the required resources. If the resource income is negative, and it doesn't quickly address it, it may not have enough resources to build the requied entities to produce the needed resource OR the units needed to build the entities may not be able to do so because their maintenance isn't being paid.
5. Some entities can attack, move, build, etc. Based on available actions (determined dynamically - NOT hardcoded) the AI should determine what actions to take. If there is danger, it should eliminate the danger so it does not lose entities and their score. Use the function in ai/utils.js to help with attack/build/repair.
6. You can look at the result from entity.getActions() to see what an entity can do. If you want to use the util functions, you can assume that if an entity has "move" and "attack" it can use the attack() util function; if it has "build" it can use the build() util function; and if it has "repair" if can use the repair() util function.
7. For now just try to maximize all 3 scores: military, econominc, exploration. There is a total score calculation which is a geometric mean of the 3 scores, and that is what we will use for winning condition. The goal should be to maximize all 3, and ideally try to keep them close together to maximize the geometric mean.
8. There is currently no machanic for scrapping entities, but add a TODO in the code where you would do this in case the AI gets stuck due to resource cost of units. 
9. Try to optimize, however the worse thing to do is get stuck, so top priority should be to not have resource deficits with resources that have low remaining stock.
10. If you need to increase resource production for some resource, you can't rely on an existing unit to build the required entity to produce the resource. You may need to work down the dependency chain to find what you can build. For example, maybe you need food, so you need to build a farm entity, but there is no worker entity to build it, so you need to build the worker entity first, and maybe there is no village entity to build the worker entity, so you need to build the village entity using a settler entity. If you can't find an entity that can satisfy the build steps at some point in the chain, then you are stuck. NOTE - I refer to entities by name, but in the implementation you MUST use entity attributes to determine what they can/should do - NEVER hardcode names.
11. add some console.log() to describe the decisions being made by the AI - You should describe the reasoning and the source/target location and owning player in the log.
12. when addressing deficits, you can't just find anything that produces the resource and try to build all of it. Instead build the most effective entities. For example if X and Y both produce the required resource, but X only produces half of Y then maybe building Y is better. However if the builder to build Y does not exist then maybe you should build X so you don't run out completely. You need some reasonable weighing of the choices and then pick the best. Also, don't build BOTH X and Y, pick the best option.
13. Use player.getResourceProfile() to determine resource yields and consumption.
14. We can't ONLY build if we have a deficit. We should also build proactively if there are not other critical goals.
15. Don't use any unit that can "attack" for combat. Instead pick the best ones. Even workers can attack, but if better units are available then pick them. If not available then consider building them.
16. Only repair entities if they are heavily damaged.
17. Don't just build the entities for best score, also consider which ones gives yields that are useful. E.g. if you already have a large surplus of wood, don't keep building wood producing entities even if they give the best score.
18. Handle exploration as per combat, don't just use any unit that can move. Pick ones that can move the most and have some ability to defend themselves, and are not needed for building and repairing. Also don't send all units in the same direction - spread out but also keep some military power to defend.
19. You must use player.getOpponents() to get visible units. Also use entity.attackHistory to see what units are attacking you and are high threats. 
20. You MAY harcode the "orders" resource name and filter it out of other resources as it is not a normal resource and the stock/income/deficit should not be considered the same as others.
21. When there is a critical deficit that can't be remedied because of resource shortage, keep track of the resources needed so that you don't spend subsequent actions in handleProactiveGrowth() building entities that use up the scarce resources.

IMPORTANT: Before implementation, ask me for any clarifications.


* handleCombatAndThreats() is not working at all. Fix any bugs and add more logging to determine exactly what is happening (e.g. what enemies are detected, which unit is selected to engage, why it fails to engage, etc) - no one is attacking barbarians, even after they attack units
