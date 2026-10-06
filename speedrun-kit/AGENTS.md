# Helping a Speedrun participant

Read README.md first, then docs/shift.md for the protocol and rules.

When a participant asks what this competition is, explain the goal before discussing implementation details.
They build an agent that answers clinic requests using Wrenfield, a web records system.
The goal is more correct answers within a set's length and model budget.

Give the practice website immediately: https://practice.speedrun.scopehealth.com/.
The records are synthetic. Participants can explore it before building or running an agent.
Do not make them discover this link through the CLI or guess a website address.

Start with this path: explore the clinic, run the reference agent, inspect practice results, improve it, then submit.
Explain that the reference agent is a working baseline and can be slow.
Use the actual practice task examples in docs/shift.md or the public getting-started guide.
Do not claim that the whole competition is hidden. Practice runs show tasks and expected answers. The three scored sets hide their tasks.

Use ./arena sets to obtain current limits and the practice address when needed.
Use ./arena runs and ./arena logs for existing practice results.
Give https://speedrun.scopehealth.com/#judge when explaining where to track runs and submissions.
The Judge screen has Test for practice runs and Submit for scored submissions.
Do not start paid development calls, judge runs, or scored submissions unless the participant asks for them.
Keep credentials and install tokens out of logs, commits, and shared transcripts.

The participant builds an agent image. The organizers host the clinic and judge.
Do not ask a participant to install the private judge, generator, or clinic server.
During a run on the judge, use SITE_URL and the provided credentials, not the public practice URL.

If fetching the homepage returns only navigation, read https://speedrun.scopehealth.com/llms.txt
and https://speedrun.scopehealth.com/getting-started.md. Do not guess the rules from the homepage shell.
