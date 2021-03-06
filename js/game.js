import { DIRECTIONS } from './defs.js';
import TILE_TYPES from './tiletypes.js';

export class Tile {
    constructor(type, direction = 'south') {
        this.type = type;
        this.direction = direction;
        this.cell = null;

        this.slide_mode = null;
        this.movement_cooldown = 0;

        if (type.has_inventory) {
            this.inventory = {};
        }
    }

    static from_template(tile_template) {
        let type = TILE_TYPES[tile_template.name];
        if (! type) console.error(tile_template.name);
        let tile = new this(type, tile_template.direction);
        if (type.load) {
            type.load(tile, tile_template);
        }
        return tile;
    }

    // Gives the effective position of an actor in motion, given smooth scrolling
    visual_position(tic_offset = 0) {
        let x = this.cell.x;
        let y = this.cell.y;
        if (! this.previous_cell) {
            return [x, y];
        }
        else {
            let p = (this.animation_progress + tic_offset) / this.animation_speed;
            return [
                (1 - p) * this.previous_cell.x + p * x,
                (1 - p) * this.previous_cell.y + p * y,
            ];
        }
    }

    blocks(other, direction, level) {
        if (this.type.blocks_all)
            return true;

        if (this.type.thin_walls &&
            this.type.thin_walls.has(DIRECTIONS[direction].opposite))
            return true;

        if (other.type.is_player && this.type.blocks_players)
            return true;
        if (other.type.is_monster && this.type.blocks_monsters)
            return true;
        if (other.type.is_block && this.type.blocks_blocks)
            return true;

        if (this.type.blocks)
            return this.type.blocks(this, level, other);

        return false;
    }

    ignores(name) {
        if (this.type.ignores && this.type.ignores.has(name))
            return true;

        if (this.inventory) {
            for (let [item, count] of Object.entries(this.inventory)) {
                if (count === 0)
                    continue;

                let item_type = TILE_TYPES[item];
                if (item_type.item_ignores && item_type.item_ignores.has(name))
                    return true;
            }
        }

        return false;
    }

    // Inventory stuff
    has_item(name) {
        return this.inventory[name] ?? 0 > 0;
    }

    // TODO remove, not undoable
    take_item(name, amount = null) {
        if (this.inventory[name] && this.inventory[name] >= 1) {
            if (amount == null && this.type.infinite_items && this.type.infinite_items[name]) {
                // Some items can't be taken away normally, by which I mean,
                // green keys
                ;
            }
            else {
                this.inventory[name] = Math.max(0, this.inventory[name] - (amount || 1));
            }
            return true;
        }
        else {
            return false;
        }
    }
}

export class Cell extends Array {
    constructor(x, y) {
        super();
        this.x = x;
        this.y = y;
    }

    _add(tile, index = null) {
        if (index === null) {
            this.push(tile);
        }
        else {
            this.splice(index, 0, tile);
        }
        tile.cell = this;
    }

    // DO NOT use me to remove a tile permanently, only to move it!
    // Should only be called from Level, which handles some bookkeeping!
    _remove(tile) {
        let index = this.indexOf(tile);
        if (index < 0)
            throw new Error("Asked to remove tile that doesn't seem to exist");

        this.splice(index, 1);
        tile.cell = null;
        return index;
    }

    blocks_leaving(actor, direction) {
        for (let tile of this) {
            if (tile !== actor &&
                ! tile.type.is_swivel && tile.type.thin_walls &&
                tile.type.thin_walls.has(direction))
            {
                return true;
            }
        }
        return false;
    }

    blocks_entering(actor, direction, level) {
        for (let tile of this) {
            if (tile.blocks(actor, direction, level) && ! actor.ignores(tile.type.name))
                return true;
        }
        return false;
    }
}

export class Level {
    constructor(stored_level, compat = {}) {
        this.stored_level = stored_level;
        this.width = stored_level.size_x;
        this.height = stored_level.size_y;
        this.size_x = stored_level.size_x;
        this.size_y = stored_level.size_y;
        this.restart(compat);
    }

    restart(compat) {
        this.compat = {};

        // playing: normal play
        // success: has been won
        // failure: died
        // note that pausing is NOT handled here, but by whatever's driving our
        // event loop!
        this.state = 'playing';

        this.cells = [];
        this.player = null;
        this.actors = [];
        this.chips_remaining = this.stored_level.chips_required;
        this.bonus_points = 0;

        // Time
        if (this.stored_level.time_limit === 0) {
            this.time_remaining = null;
        }
        else {
            this.time_remaining = this.stored_level.time_limit * 20;
        }
        this.timer_paused = false;
        this.tic_counter = 0;
        // 0 to 7, indicating the first tic that teeth can move on.
        // 0 is equivalent to even step; 4 is equivalent to odd step.
        // 5 is the default in CC2.  Lynx can use any of the 8.  MSCC uses
        // either 0 or 4, and defaults to 0, but which you get depends on the
        // global clock which doesn't get reset between levels (!).
        this.step_parity = 5;

        this.hint_shown = null;
        // TODO in lynx/steam, this carries over between levels; in tile world, you can set it manually
        this.force_floor_direction = 'north';

        this.undo_stack = [];
        this.pending_undo = [];

        let n = 0;
        let connectables = [];
        // FIXME handle traps correctly:
        // - if an actor is in the cell, set the trap to open and unstick everything in it
        for (let y = 0; y < this.height; y++) {
            let row = [];
            this.cells.push(row);
            for (let x = 0; x < this.width; x++) {
                let cell = new Cell(x, y);
                row.push(cell);

                let stored_cell = this.stored_level.linear_cells[n];
                n++;
                let has_cloner, has_trap, has_forbidden;

                for (let template_tile of stored_cell) {
                    let tile = Tile.from_template(template_tile);
                    if (tile.type.is_hint) {
                        // Copy over the tile-specific hint, if any
                        tile.specific_hint = template_tile.specific_hint ?? null;
                    }

                    // TODO well this is pretty special-casey.  maybe come up
                    // with a specific pass at the beginning of the level?
                    // TODO also assumes a specific order...
                    if (tile.type.name === 'cloner') {
                        has_cloner = true;
                    }
                    if (tile.type.name === 'trap') {
                        has_trap = true;
                    }

                    if (tile.type.is_player) {
                        // TODO handle multiple players, also chip and melinda both
                        // TODO complain if no chip
                        this.player = tile;
                        // Always put the player at the start of the actor list
                        // (accomplished traditionally with a swap)
                        this.actors.push(this.actors[0]);
                        this.actors[0] = tile;
                    }
                    else if (tile.type.is_actor) {
                        if (has_cloner) {
                            tile.stuck = true;
                        }
                        else {
                            if (has_trap) {
                                // FIXME wait, not if the trap is open!  crap
                                tile.stuck = true;
                            }
                            this.actors.push(tile);
                        }
                    }
                    cell._add(tile);

                    if (tile.type.connects_to) {
                        connectables.push(tile);
                    }
                }
            }
        }

        // Connect buttons and teleporters
        let num_cells = this.width * this.height;
        for (let connectable of connectables) {
            let cell = connectable.cell;
            let x = cell.x;
            let y = cell.y;
            let goal = connectable.type.connects_to;
            let found = false;

            // Check for custom wiring, for MSCC .DAT levels
            let n = x + y * this.width;
            let target_cell_n = null;
            if (goal === 'trap') {
                target_cell_n = this.stored_level.custom_trap_wiring[n] ?? null;
            }
            else if (goal === 'cloner') {
                target_cell_n = this.stored_level.custom_cloner_wiring[n] ?? null;
            }
            if (target_cell_n) {
                // TODO this N could be outside the map bounds
                let target_cell_x = target_cell_n % this.width;
                let target_cell_y = Math.floor(target_cell_n / this.width);
                for (let tile of this.cells[target_cell_y][target_cell_x]) {
                    if (tile.type.name === goal) {
                        connectable.connection = tile;
                        found = true;
                        break;
                    }
                }
                if (found)
                    continue;
            }

            // Otherwise, look in reading order
            let direction = 1;
            if (connectable.type.connect_order === 'backward') {
                direction = -1;
            }
            for (let i = 0; i < num_cells - 1; i++) {
                x += direction;
                if (x >= this.width) {
                    x -= this.width;
                    y = (y + 1) % this.height;
                }
                else if (x < 0) {
                    x += this.width;
                    y = (y - 1 + this.height) % this.height;
                }

                for (let tile of this.cells[y][x]) {
                    if (tile.type.name === goal) {
                        // TODO should be weak, but you can't destroy cloners so in practice not a concern
                        connectable.connection = tile;
                        found = true;
                        break;
                    }
                }
                if (found)
                    break;
            }
            // TODO soft warn for e.g. a button with no cloner?  (or a cloner with no button?)
        }
    }

    // Move the game state forwards by one tic
    advance_tic(player_direction) {
        if (this.state !== 'playing') {
            console.warn(`Level.advance_tic() called when state is ${this.state}`);
            return;
        }

        // XXX this entire turn order is rather different in ms rules
        // FIXME OK, do a pass to make everyone decide their movement, and then actually do it.  the question iiis, where does that fit in with animation
        // First pass: tick cooldowns and animations; have actors arrive in their cells
        for (let actor of this.actors) {
            // Actors with no cell were destroyed
            if (! actor.cell)
                continue;

            // Decrement the cooldown here, but don't check it quite yet,
            // because stepping on cells in the next block might reset it
            if (actor.movement_cooldown > 0) {
                this._set_prop(actor, 'movement_cooldown', actor.movement_cooldown - 1);
            }

            if (actor.animation_speed) {
                // Deal with movement animation
                actor.animation_progress += 1;
                if (actor.animation_progress >= actor.animation_speed) {
                    if (actor.type.ttl) {
                        // This is purely an animation so it disappears once it's played
                        this.remove_tile(actor);
                        continue;
                    }
                    actor.previous_cell = null;
                    actor.animation_progress = null;
                    actor.animation_speed = null;
                    if (! this.compat.tiles_react_instantly) {
                        this.step_on_cell(actor);
                    }
                }
            }
        }

        // Second pass: actors decide their upcoming movement simultaneously
        for (let actor of this.actors) {
            // Note that this prop is only used internally within a single iteration of this loop,
            // so it doesn't need to be undoable
            actor.decision = null;

            if (! actor.cell)
                continue;

            if (actor.movement_cooldown > 0)
                continue;

            // XXX does the cooldown drop while in a trap?  is this even right?
            // TODO should still attempt to move (so chip turns), just will be stuck (but wait, do monsters turn?  i don't think so)
            if (actor.stuck)
                continue;

            // Teeth can only move the first 4 of every 8 tics, though "first"
            // can be adjusted
            if (actor.type.uses_teeth_hesitation && (this.tic_counter + this.step_parity) % 8 >= 4)
                continue;

            let direction_preference;
            // Actors can't make voluntary moves on ice, so they're stuck with
            // whatever they've got
            if (actor.slide_mode === 'ice') {
                direction_preference = [actor.direction];
            }
            else if (actor.slide_mode === 'force') {
                // Only the player can make voluntary moves on a force floor,
                // and only if their previous move was an /involuntary/ move on
                // a force floor.  If they do, it overrides the forced move
                // XXX this in particular has some subtleties in lynx (e.g. you
                // can override forwards??) and DEFINITELY all kinds of stuff
                // in ms
                if (actor === this.player &&
                    player_direction &&
                    actor.last_move_was_force)
                {
                    direction_preference = [player_direction];
                    this._set_prop(actor, 'last_move_was_force', false);
                }
                else {
                    direction_preference = [actor.direction];
                    if (actor === this.player) {
                        this._set_prop(actor, 'last_move_was_force', true);
                    }
                }
            }
            else if (actor === this.player) {
                if (player_direction) {
                    direction_preference = [player_direction];
                    this._set_prop(actor, 'last_move_was_force', false);
                }
            }
            else if (actor.type.movement_mode === 'forward') {
                // blue tank behavior: keep moving forward
                direction_preference = [actor.direction];
            }
            else if (actor.type.movement_mode === 'follow-left') {
                // bug behavior: always try turning as left as possible, and
                // fall back to less-left turns when that fails
                let d = DIRECTIONS[actor.direction];
                direction_preference = [d.left, actor.direction, d.right, d.opposite];
            }
            else if (actor.type.movement_mode === 'follow-right') {
                // paramecium behavior: always try turning as right as
                // possible, and fall back to less-right turns when that fails
                let d = DIRECTIONS[actor.direction];
                direction_preference = [d.right, actor.direction, d.left, d.opposite];
            }
            else if (actor.type.movement_mode === 'turn-left') {
                // glider behavior: preserve current direction; if that doesn't
                // work, turn left, then right, then back the way we came
                let d = DIRECTIONS[actor.direction];
                direction_preference = [actor.direction, d.left, d.right, d.opposite];
            }
            else if (actor.type.movement_mode === 'turn-right') {
                // fireball behavior: preserve current direction; if that doesn't
                // work, turn right, then left, then back the way we came
                let d = DIRECTIONS[actor.direction];
                direction_preference = [actor.direction, d.right, d.left, d.opposite];
            }
            else if (actor.type.movement_mode === 'bounce') {
                // bouncy ball behavior: preserve current direction; if that
                // doesn't work, bounce back the way we came
                let d = DIRECTIONS[actor.direction];
                direction_preference = [actor.direction, d.opposite];
            }
            else if (actor.type.movement_mode === 'bounce-random') {
                // walker behavior: preserve current direction; if that
                // doesn't work, pick a random direction, even the one we
                // failed to move in
                // TODO unclear if this is right in cc2 as well.  definitely not in ms, which chooses a legal move
                direction_preference = [actor.direction, ['north', 'south', 'east', 'west'][Math.floor(Math.random() * 4)]];
            }
            else if (actor.type.movement_mode === 'pursue') {
                // teeth behavior: always move towards the player
                let dx = actor.cell.x - this.player.cell.x;
                let dy = actor.cell.y - this.player.cell.y;
                let preferred_horizontal, preferred_vertical;
                if (dx > 0) {
                    preferred_horizontal = 'west';
                }
                else if (dx < 0) {
                    preferred_horizontal = 'east';
                }
                if (dy > 0) {
                    preferred_vertical = 'north';
                }
                else if (dy < 0) {
                    preferred_vertical = 'south';
                }
                // Chooses the furthest direction, vertical wins ties
                if (Math.abs(dx) > Math.abs(dy)) {
                    // Horizontal first
                    direction_preference = [preferred_horizontal, preferred_vertical].filter(x => x);
                }
                else {
                    // Vertical first
                    direction_preference = [preferred_vertical, preferred_horizontal].filter(x => x);
                }
            }
            else if (actor.type.movement_mode === 'random') {
                // blob behavior: move completely at random
                // TODO cc2 has twiddles for how this works per-level, as well as the initial seed for demo playback
                direction_preference = [['north', 'south', 'east', 'west'][Math.floor(Math.random() * 4)]];
            }

            // Check which of those directions we *can*, probably, move in
            // TODO i think player on force floor will still have some issues here
            if (direction_preference) {
                // Players and sliding actors always move the way they want, even if blocked
                if (actor.type.is_player || actor.slide_mode) {
                    actor.decision = direction_preference[0];
                    continue;
                }

                for (let direction of direction_preference) {
                    let dest_cell = this.cell_with_offset(actor.cell, direction);
                    if (! dest_cell)
                        continue;

                    if (! actor.cell.blocks_leaving(actor, direction) &&
                        ! dest_cell.blocks_entering(actor, direction, this))
                    {
                        // We found a good direction!  Stop here
                        actor.decision = direction;
                        break;
                    }
                }
            }
        }

        // Third pass: everyone actually moves
        for (let actor of this.actors) {
            if (! actor.cell)
                continue;

            if (! actor.decision)
                continue;

            this.set_actor_direction(actor, actor.decision);
            this.attempt_step(actor, actor.decision);

            // TODO do i need to do this more aggressively?
            if (this.state === 'success' || this.state === 'failure')
                break;
        }

        // Strip out any destroyed actors from the acting order
        let p = 0;
        for (let i = 0, l = this.actors.length; i < l; i++) {
            let actor = this.actors[i];
            if (actor.cell) {
                if (p !== i) {
                    this.actors[p] = actor;
                }
                p++;
            }
        }
        this.actors.length = p;

        // Advance the clock
        let tic_counter = this.tic_counter;
        this.tic_counter += 1;
        if (this.time_remaining !== null && ! this.timer_paused) {
            let time_remaining = this.time_remaining;
            this.pending_undo.push(() => {
                this.tic_counter = tic_counter;
                this.time_remaining = time_remaining;
            });

            this.time_remaining -= 1;
            if (this.time_remaining <= 0) {
                this.fail("Time's up!");
            }
        }
        else {
            this.pending_undo.push(() => {
                this.tic_counter = tic_counter;
            });
        }

        // Commit the undo state at the end of each tic
        this.commit();
    }

    // Try to move the given actor one tile in the given direction and update
    // their cooldown.  Return true if successful.
    attempt_step(actor, direction, speed = null) {
        if (actor.stuck)
            return false;

        // If speed is given, we're being pushed by something so we're using
        // its speed.  Otherwise, use our movement speed.  If we're moving onto
        // a sliding tile, we'll halve it later
        let check_for_slide = false;
        if (speed === null) {
            speed = actor.type.movement_speed;
            check_for_slide = true;
        }

        let move = DIRECTIONS[direction].movement;
        if (!actor.cell) console.error(actor);
        let goal_cell = this.cell_with_offset(actor.cell, direction);

        // TODO this could be a lot simpler if i could early-return!  should ice bumping be
        // somewhere else?
        let blocked;
        if (goal_cell) {
            if (actor.cell.blocks_leaving(actor, direction)) {
                blocked = true;
            }

            // Only bother touching the goal cell if we're not already trapped
            // in this one
            // (Note that here, and anywhere else that has any chance of
            // altering the cell's contents, we iterate over a copy of the cell
            // to insulate ourselves from tiles appearing or disappearing
            // mid-iteration.)
            // FIXME actually, this prevents flicking!
            if (! blocked) {
                // This is similar to Cell.blocks_entering, but we have to do a little more work
                // FIXME splashes should block you (e.g. pushing a block off a
                // turtle) but currently do not because of this copy; we don't
                // notice a new thing was added to the tile  :(
                for (let tile of Array.from(goal_cell)) {
                    if (check_for_slide && tile.type.slide_mode && ! actor.ignores(tile.type.name)) {
                        check_for_slide = false;
                        speed /= 2;
                    }

                    if (actor.ignores(tile.type.name))
                        continue;
                    if (! tile.blocks(actor, direction, this))
                        continue;

                    if (actor.type.pushes && actor.type.pushes[tile.type.name] && ! tile.stuck) {
                        this.set_actor_direction(tile, direction);
                        if (this.attempt_step(tile, direction, speed))
                            // It moved out of the way!
                            continue;
                    }
                    if (tile.type.on_bump) {
                        tile.type.on_bump(tile, this, actor);
                        if (! tile.blocks(actor, direction, this))
                            // It became something non-blocking!
                            continue;
                    }
                    blocked = true;
                    // XXX should i break here, or bump everything?
                }
            }
        }
        else {
            // Hit the edge
            blocked = true;
        }

        if (blocked) {
            if (actor.slide_mode === 'ice') {
                // Actors on ice turn around when they hit something
                this.set_actor_direction(actor, DIRECTIONS[direction].opposite);
                // Somewhat clumsy hack: step on the ice tile again, so if it's
                // a corner, it'll turn us in the correct direction
                for (let tile of actor.cell) {
                    if (tile.type.slide_mode === 'ice' && tile.type.on_arrive) {
                        tile.type.on_arrive(tile, this, actor);
                    }
                }
            }
            return false;
        }

        // We're clear!
        this.move_to(actor, goal_cell, speed);

        // Set movement cooldown since we just moved
        this._set_prop(actor, 'movement_cooldown', speed);
        return true;
    }

    // Move the given actor to the given position and perform any appropriate
    // tile interactions.  Does NOT check for whether the move is actually
    // legal; use attempt_step for that!
    move_to(actor, goal_cell, speed) {
        if (actor.cell === goal_cell)
            return;

        actor.previous_cell = actor.cell;
        actor.animation_speed = speed;
        actor.animation_progress = 0;

        let original_cell = actor.cell;
        this.remove_tile(actor);
        this.make_slide(actor, null);
        this.add_tile(actor, goal_cell);

        // Announce we're leaving, for the handful of tiles that care about it
        for (let tile of Array.from(original_cell)) {
            if (tile === actor)
                continue;
            if (actor.ignores(tile.type.name))
                continue;

            if (tile.type.on_depart) {
                tile.type.on_depart(tile, this, actor);
            }
        }

        // Check for a couple effects that always apply immediately
        // TODO i guess this covers blocks too
        // TODO do blocks smash monsters?
        for (let tile of goal_cell) {
            if (tile.type.slide_mode && ! actor.ignores(tile.type.name)) {
                this.make_slide(actor, tile.type.slide_mode);
            }
            if ((actor.type.is_player && tile.type.is_monster) ||
                (actor.type.is_monster && tile.type.is_player))
            {
                // TODO ooh, obituaries
                this.fail("Oops!  Watch out for creatures!");
                return;
            }
            if (actor.type.is_block && tile.type.is_player) {
                // TODO ooh, obituaries
                this.fail("squish");
                return;
            }
        }

        if (this.compat.tiles_react_instantly) {
            this.step_on_cell(actor);
        }
    }

    // Step on every tile in a cell we just arrived in
    step_on_cell(actor) {
        if (actor === this.player) {
            this._set_prop(this, 'hint_shown', null);
        }
        let teleporter;
        for (let tile of Array.from(actor.cell)) {
            if (tile === actor)
                continue;
            if (actor.ignores(tile.type.name))
                continue;

            if (actor === this.player && tile.type.is_hint) {
                this._set_prop(this, 'hint_shown', tile.specific_hint ?? this.stored_level.hint);
            }

            if (tile.type.is_item && this.give_actor(actor, tile.type.name)) {
                this.remove_tile(tile);
            }
            else if (tile.type.is_teleporter) {
                teleporter = tile;
            }
            else if (tile.type.on_arrive) {
                tile.type.on_arrive(tile, this, actor);
            }
        }

        // Handle teleporting, now that the dust has cleared
        // FIXME something funny happening here, your input isn't ignore while walking out of it?
        let current_cell = actor.cell;
        if (teleporter) {
            let goal = teleporter.connection;
            // TODO in pathological cases this might infinite loop
            while (true) {
                // Physically move the actor to the new teleporter
                // XXX is this right, compare with tile world?  i overhear it's actually implemented as a slide?
                // XXX will probably play badly with undo lol
                let tele_cell = goal.cell;
                current_cell._remove(actor);
                tele_cell._add(actor);
                current_cell = tele_cell;
                if (this.attempt_step(actor, actor.direction))
                    // Success, teleportation complete
                    break;
                if (goal === teleporter)
                    // We've tried every teleporter, including the one they
                    // stepped on, so leave them on it
                    break;

                // Otherwise, try the next one
                goal = goal.connection;
            }
        }
    }

    cell_with_offset(cell, direction) {
        let move = DIRECTIONS[direction].movement;
        let goal_x = cell.x + move[0];
        let goal_y = cell.y + move[1];
        if (goal_x >= 0 && goal_x < this.width && goal_y >= 0 && goal_y < this.height) {
            return this.cells[goal_y][goal_x];
        }
        else {
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // Undo handling

    commit() {
        this.undo_stack.push(this.pending_undo);
        this.pending_undo = [];

        // Limit the stack to, idk, 200 tics (10 seconds)
        if (this.undo_stack.length > 200) {
            this.undo_stack.splice(0, this.undo_stack.length - 200);
        }
    }

    undo() {
        let entry = this.undo_stack.pop();
        // Undo in reverse order!  There's no redo, so it's okay to destroy this
        entry.reverse();
        for (let undo of entry) {
            undo();
        }
    }

    // -------------------------------------------------------------------------
    // Level alteration methods.  EVERYTHING that changes the state of a level,
    // including the state of a single tile, should do it through one of these
    // for undo/rewind purposes

    _set_prop(obj, key, val) {
        let old_val = obj[key];
        if (val === old_val)
            return;
        this.pending_undo.push(() => obj[key] = old_val);
        obj[key] = val;
    }

    collect_chip() {
        let current = this.chips_remaining;
        if (current > 0) {
            this.pending_undo.push(() => this.chips_remaining = current);
            this.chips_remaining--;
        }
    }

    adjust_bonus(add, mult = 1) {
        let current = this.bonus_points;
        this.pending_undo.push(() => this.bonus_points = current);
        this.bonus_points = Math.ceil(this.bonus_points * mult) + add;
    }

    pause_timer() {
        if (this.time_remaining === null)
            return;

        this.pending_undo.push(() => this.timer_paused = ! this.timer_paused);
        this.timer_paused = ! this.timer_paused;
    }

    adjust_timer(dt) {
        let current = this.time_remaining;
        this.pending_undo.push(() => this.time_remaining = current);

        // Untimed levels become timed levels with 0 seconds remaining
        this.time_remaining = Math.max(0, (this.time_remaining ?? 0) + dt * 20);
        if (this.time_remaining <= 0) {
            if (this.timer_paused) {
                this.time_remaining = 1;
            }
            else {
                this.fail("Time's up!");
            }
        }
    }

    fail(message) {
        this.pending_undo.push(() => {
            this.state = 'playing';
            this.fail_message = null;
        });
        this.state = 'failure';
        this.fail_message = message;
    }

    win() {
        this.pending_undo.push(() => this.state = 'playing');
        this.state = 'success';
    }

    // Get the next direction a random force floor will use.  They share global
    // state and cycle clockwise.
    get_force_floor_direction() {
        let d = this.force_floor_direction;
        this.force_floor_direction = DIRECTIONS[d].right;
        return d;
    }

    // Tile stuff in particular
    // TODO should add in the right layer?  maybe?

    remove_tile(tile) {
        let cell = tile.cell;
        let index = cell._remove(tile);
        this.pending_undo.push(() => cell._add(tile, index));
    }

    add_tile(tile, cell, index = null) {
        cell._add(tile, index);
        this.pending_undo.push(() => cell._remove(tile));
    }

    spawn_animation(cell, name) {
        let type = TILE_TYPES[name];
        let tile = new Tile(type);
        tile.animation_speed = type.ttl;
        tile.animation_progress = 0;
        cell._add(tile);
        this.actors.push(tile);
        this.pending_undo.push(() => {
            this.actors.pop();
            cell._remove(tile);
        });
    }

    transmute_tile(tile, name) {
        let current = tile.type.name;
        this.pending_undo.push(() => tile.type = TILE_TYPES[current]);
        tile.type = TILE_TYPES[name];
        // TODO adjust anything else?
    }

    give_actor(actor, name) {
        if (! actor.type.has_inventory)
            return false;

        let current = actor.inventory[name];
        this.pending_undo.push(() => actor.inventory[name] = current);
        actor.inventory[name] = (current ?? 0) + 1;
        return true;
    }

    // Mark an actor as sliding
    make_slide(actor, mode) {
        let current = actor.slide_mode;
        this.pending_undo.push(() => actor.slide_mode = current);
        actor.slide_mode = mode;
    }

    // Change an actor's direction
    set_actor_direction(actor, direction) {
        let current = actor.direction;
        this.pending_undo.push(() => actor.direction = current);
        actor.direction = direction;
    }

    set_actor_stuck(actor, is_stuck) {
        let current = actor.stuck;
        if (current === is_stuck)
            return;
        this.pending_undo.push(() => actor.stuck = current);
        actor.stuck = is_stuck;
    }
}
