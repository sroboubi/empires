Visual:
- unit lighting and shadows
- skybox and sun
- frame drop and lagging?
- smooth move
- animations and effects (damage, attack)
- when AI is thinking, do a day/night cycle

Game:
- resources init on grid
- adjacency logic; village next to each other, resource extractors next to resources

- adjust melee and ranged attack damage based on source to target delta elevation

- score: military (add military unit power) + economic (resource accumulated and income) + territory (villages and other constructs)
- win condition: total score is 2X the next largest score 

Later:
- entities add/remove themselves from gamestate?
- unit vision considers center of cell, some cells that are partly visible are hidden - fix?