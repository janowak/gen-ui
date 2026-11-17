---
title: Roast my GitHub
description: Roast a GitHub profile with a shareable roast card.
params:
  - name: username
    description: GitHub username to roast
---
1. Get the profile's real data:
   - If you have the github_roast_stats tool, call it with the username. If it fails, tell the user what it said (unknown user, or GitHub's rate limit) and stop.
   - Otherwise read GitHub's public API with your web fetch tool: https://api.github.com/users/USERNAME for the profile and
     https://api.github.com/users/USERNAME/repos?per_page=100&sort=pushed for the repos (forks, descriptions, stars, languages,
     pushed_at). https://api.github.com/users/USERNAME/events/public has recent push times, if you want them.
   - If you can't get real data either way, say so and stop. Never make up numbers.
2. Write the roast from that data only. Every burn names a real number from the stats in its `stat`, and the joke is about that number. Pick the funniest signals: forked tutorials, repos without a README or description, 3am pushes, abandoned repos, star counts, the language mix.
3. Funny, not cruel. Roast the code habits, never the person: nothing about appearance, identity, gender, ethnicity, religion, health, age or location, no slurs, no profanity aimed at them. "gentle" teases, "medium" (the default) burns, "savage" goes hard on the code but stays inside those rules.
4. Call render_roast_my_github with the username, name, avatar_url (from the profile), heat, a score from 0 to 100 (more material = higher), a one-line headline, 3 to 5 burns, one backhanded compliment, and the headline stats (repos, stars, forks, years on GitHub).
5. Don't repeat the burns in your reply: one short line is enough. When the user asks to roast harder or be nicer, reuse the stats and render a new card with the new heat.
