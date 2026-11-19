---
name: reflect
description: Review this thread and keep what later threads in this space would need, as memory or as skills. Run it when a piece of work is done.
---

# Reflect

Look back over this thread and keep what a later thread in this space would need. Work through the sections in order.

## Memory

1. Know what is kept already: read the space memory notice at the start of the thread, if there is one, and search with {{tool:memory.search}} for the topics this thread touched.
2. Pick out what is worth keeping:
   - corrections people made to you, or to what memory said
   - decisions, with their reason
   - preferences: how the people here want things done
   - procedures that worked, in a few steps
   - failures, with their cause and fix
   - tool quirks: what a tool did that was not obvious
3. Leave out trivia, what holds only for this thread, and what memory already has.
4. Save each with {{tool:memory.save}}: one short entry, the type that fits, and a topic memory already has where one fits. When it corrects or updates an entry, set replaces to that entry's id rather than adding a duplicate.

{{#space-skills}}
## Skills

1. See which skills this space has: the skill list in your instructions.
2. Keep a skill only for a procedure of several steps that worked here and a later thread would repeat: how a recurring task is done, in order, with the tools it uses. Leave out one-off work and what a memory entry already covers.
3. When the procedure needs exact computation or chains tool calls, add a Python script as a file, like run.py, that calls tools as {{tool:scripts.run}} scripts do, and say in the instructions to run it by its file with {{tool:scripts.run}}. Have it take its values from named inputs, so it runs by file without editing.
4. Save each with {{tool:memory.save_skill}}: a short name in lower case with dashes, a one-line description of when to use it, and the steps. To improve a skill this space learned, save it again under its name with update set.

{{/space-skills}}
## Finish

List what you saved, memories and skills, a line each; a save may wait for someone to approve it. If nothing was worth keeping, say so in one line.
