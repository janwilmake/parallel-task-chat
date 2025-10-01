https://taskchat.p0web.com

https://taskchat.p0web.com/demo

What i did:

- turn everything into a `reasoning_content` and the final result into a `content` in a json codeblock
- ensure not to duplicate stats when putting them as reasoning (they're duplicated often in task events)
- added throttling so latest event is pushed only at ±50 tokens per second

To be determined:

![](challenge.png)
