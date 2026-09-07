# TODO #

## Visual ##

- only zoom to human player units

## Audio ##

- sound effects
- music

## Game ##

- prevent movement through enemy entities, and implement zone of control
- prevent movement across tiles that units can't stand on, like water (check intermediate path)
- call onActionDone with affected cells so we don't delay for invisible actions 
- resources init on grid - adjust resource extractor yields next to resources

## Later ##

- entities add/remove themselves from gamestate?
- unit vision considers center of cell, some cells that are partly visible are hidden - fix?
- frame drop and lagging?
- smooth move and animations
