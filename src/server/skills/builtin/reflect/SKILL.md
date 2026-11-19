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
3. Write the shortest procedure that works every time: when to use it, the exact call, decision points, what to return, and the limits that matter.
4. When the procedure needs exact computation or chains tool calls, add a Python script as a file, like run.py, that calls tools as {{tool:scripts.run}} scripts do and reads its values from named inputs. The instructions give its file and input names; it runs by file, so reading its source is not a step.
5. Before saving, run the script's code once with {{tool:scripts.run}} and the inputs the instructions give, where that is safe: tools that only read, or calls people approve anyway. Check that the instructions and the script agree, including on missing data, pagination, ordering and partial results where they could change the answer.
6. Save each with {{tool:memory.save_skill}}: a short name in lower case with dashes, a one-line description of when to use it, and the steps. To improve a skill this space learned, save it again under its name with update set.
7. Where a skill let you down in this thread, fix it where the fault is: a broken or brittle script, fix it and test it as above, then save the skill with update; a misleading instruction, update the skill; a quirk of a tool outside this space's control, a memory entry; a one-off, nothing.

{{/space-skills}}
## Finish

List what you saved, memories and skills, a line each; a save may wait for someone to approve it. If nothing was worth keeping, say so in one line. If you misread how this system works, such as the scripts runtime or a tool, say so in a line, so people can fix the instructions you were given.
