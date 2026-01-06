<p align="center"><img src="https://raw.githubusercontent.com/pixlcore/xyplug-stagehand/refs/heads/main/logo.png" height="108" alt="Stagehand"/></p>
<h1 align="center">Stagehand Automation Plugin</h1>

A Stagehand event plugin for the [xyOps Workflow Automation System](https://xyops.io). This package provides an AI-powered browser automation framework for xyOps.  Using it you can drive a headless browser with simple English instructions, take actions, extract data, capture network requests, and even record a video of the whole session.

A headless Chromium is launched and automated locally in a Docker container.  This Plugin does not use any "cloud" browser environments.  Note that if you use any of the AI features, then you need to be careful with sensitive information, as they may be sent to the AI provider.  See below for discussion and mitigation techniques.

This Plugin relies heavily on the [Stagehand](https://github.com/browserbase/stagehand) and [Playwright](https://github.com/microsoft/playwright) libraries. See those repos for full documentation and low-level usage.

## Requirements

- **Docker**
	- This Plugin ships as a prebuilt Docker container, so your xyOps servers will need Docker installed for this to work.
- **AI Credentials**
	- If you intend to use any of the AI features, you will need an API Key for your chosen provider.

## Environment Variables

If you are going to use the AI features in Stagehand, create a [Secret Vault](https://xyops.io/docs/secrets) in xyOps and assign this Plugin to it.  Add your AI provider's API Key in a new variable named:

```
AI_API_KEY
```

Stagehand supports Google, OpenAI, Anthropic, xAI, DeepSeek, Perplexity, Azure, Ollama, or any other LLM model from the [Vercel AI SDK](https://sdk.vercel.ai/providers).

## Usage

### Script

The Plugin "Script" parameter is expected to be a list of instructions for the browser to perform, one per line.  It can be plain text or [JSON](#advanced).  This section will focus on the plain text format, which looks like this:

```
Navigate to https://mycompany.com/
Type "foo" into the Username text field.
Type "bar" into the Password text field.
Click the "Login" button.
Sleep for 3000
```

Each line should contain a simple instruction (i.e. one action).  For each line, the Plugin defaults to calling Stagehand [act()](https://docs.stagehand.dev/v3/basics/act) unless prefixed by a specific keyword.  See below for specific keywords.

### Perform Actions

The default behavior is to [act()](https://docs.stagehand.dev/v3/basics/act) (take action) on the instruction.  This expects commands such as:

| Action | Example instruction |
|--------|---------------------|
| Click | `click the button` |
| Fill | `fill the field with <value>` |
| Type | `type <text> into the search box` |
| Press | `press <key> in the search field` |
| Scroll | `scroll to <position>` |
| Select | `select <value> from the dropdown` |

### Browser Navigation

You can navigate to URLs at any time, by starting the line with the word "Navigate":

```
Navigate to https://news.ycombinator.com/
```

### Extract Data

To extract data from the page, begin the line with the word "Extract", and describe exactly what you want, including the desired output format.  Example:

```
Extract the first three article titles, in a JSON array.
```

The extraction results will be included in the Job output data, in an array called `extractions`.  Example output:

```json
{
	"extractions": [
		{
			"prompt": "Extract the first three article titles, in a JSON array.",
			"result": [
				"Same-day upstream Linux support for Snapdragon 8 Elite Gen 5",
				"Underrated reasons to be thankful V",
				"Physicists drive antihydrogen breakthrough at CERN"
			]
		}
	]
}
```

If you ask for JSON in the extraction prompt, and the extraction itself is valid JSON, it is parsed for you and included as an object/array in the "result" property.  Otherwise, it will be a text string.

This feature uses the Stagehand [extract()](https://docs.stagehand.dev/v3/basics/extract) function.

### Capture Network Requests

To capture network requests, including raw responses, include a line in your script starting with the word "Capture", followed by a URL (substring match).  Example:

```
Capture /y18.svg
```

Make sure you add your captures *before* you navigate to the page or take the action that will trigger the network request.  This command installs a "listener" on all network requests that match the URL you specify (which can be partial; it's a substring match).

For any matches, results will be included in the Job output data, in an array called `captures`.  Example output:

```json
{
	"captures": [
		{
			"url": "https://news.ycombinator.com/y18.svg",
			"status": 200,
			"headers": { "Content-Type": "image/svg" },
			"response": "<svg height=\\"18\\" viewBox=\\"4 4 188 188\\" width=\\"18\\" xmlns=\\"http://www.w3.org/2000/svg\\"><path d=\\"m4 4h188v188h-188z\\" fill=\\"#f60\\"/><path d=\\"m73.2521756 45.01 22.7478244 47.39130083 22.7478244-47.39130083h19.56569631l-34.32352071 64.48661468v41.49338532h-15.98v-41.49338532l-34.32352071-64.48661468z\\" fill=\\"#fff\\"/></svg>"
		}
	]
}
```

If the response appears to be JSON, it will be parsed and returned as an object/array.  Otherwise it will be a string, as shown above.  This should only be used for text-based resources, not binary ones.

### Evaluate JavaScript

To evaluate arbitrary JavaScript code in the browser (in the context of the current page), include a line in your script starting with the word "Evaluate", followed by the JavaScript code to run.  Example:

```
Evaluate 4 + 5
```

For any evaluations, results will be included in the Job output data, in an array called `evaluations`.  Example output:

```json
{
	"evaluations": [
		{
			"script": "4 + 5",
			"result": 9
		}
	]
}
```

### Sleep

To insert a sleep step for a specified duration, add a line in your script starting with the word "Sleep", followed by the number of milliseconds to sleep for  Example:

```
Sleep 5000
```

### Downloads

If you trigger any downloads during the browser session, they will be attached to the Job output as files.  These can be used in downstream jobs if connected via workflow or run action.

## Advanced

In addition to the simple text script format shown above, you can alternatively pass a JSON object as the script.  This allows you to specify advanced options and perform exact browser actions (i.e. not using AI).  Here is the format expected:

```json
{
	"steps": [
		{
			"type": "navigate",
			"url": "https://mycompany.com/"
		},
		{
			"type": "change",
			"selectors": ["aria/Username", "form > div:nth-of-type(1) input"],
			"value": "foo"
		},
		{
			"type": "change",
			"selectors": ["aria/Password", "form > div:nth-of-type(2) input"],
			"value": "bar"
		},
		{
			"type": "click",
			"selectors": ["aria/Login", "form > button"]
		}
	]
}
```

The `steps` property should be an array of objects.  Each object should have a `type` property, and other type-specific properties.  Here are the available types, and their required properties:

| Type | Params | Description |
|------|--------|-------------|
| `navigate` | `url` | Navigate to a new URL specified by `url`, and wait for the `load` event to fire. |
| `click` | `selectors` | Click on a target specified by whichever of the `selectors` matches first. |
| `doubleClick` | `selectors` | Double-click on a target specified by whichever of the `selectors` matches first. |
| `change` | `selectors`, `value` | Change a form field, specified by whichever of the `selectors` matches first, to the `value` value. |
| `keyDown` | `key` | Press down a specific key on the keyboard, specified by `key`. |
| `keyUp` | `key` | Release a specific key on the keyboard, specified by `key`. |
| `text` | `text` | Type in a string of `text`, just as if it was typed from the keyboard. |
| `evaluate` | `script` | Evaluate JavaScript code in the browser, in the context of the current page. |
| `sleep` | `duration` | Sleep for the specified amount of milliseconds in `duration`. |
| `waitFor` | `selectors` | Wait for any of the `selectors` to be visible. |
| `reload` | - | Reload the current page and wait for the `load` event to fire. |
| `capture` | `url` | Start a network capture for all requests matching URL or partial URL specified by `url`. |
| `action` | `prompt` | **(Uses AI)** Take action on the page using AI and a natural language prompt. |
| `extract` | `prompt` | **(Uses AI)** Extract content from the page using AI and a natural language prompt. |

### Advanced Capture

For the `capture` type, there are two optional properties you can set:

- If you set `download` to `true`, the raw response will be downloaded instead of included in the Job output data object.
- If you also set `pretty` to `true`, and the response is JSON format, it will be pretty-printed in the downloaded file.

These options are useful for capturing **large** amounts of data that you don't want passed around inside the job object, for memory and/or performance concerns, or if the response is binary.  Downloaded files are still attached to the job and passed to the next job via workflow or run action, as well as made available for viewing / downloading in the xyOps UI.

### Replay Chrome Recordings

The advanced JSON format described above is actually compatible with the [Chrome Dev Tools Recorder](https://developer.chrome.com/docs/devtools/recorder) feature, specifically its JSON export format.

To access the recorder, while in Chrome Dev Tools, press `Control+Shift+P` (Windows / Linux) or `Command+Shift+P` (Mac), and type "Recorder", then hit Enter.

When you finish a recording, while still on the detail view in Dev Tools, if you click the tiny little "Download" (downward-facing arrow) button in the toolbar, you can choose from a variety of formats.  Select "JSON", save the file, and then you can copy & paste (or just directly upload) the file into the xyOps Plugin Script Editor.

### Exit Steps

If your script has steps that must **always** be executed, even in the event of an error, include an `always` property and set it to `true`.  This feature can be used for situations like a logout sequence, which must be executed even if the other steps failed for whatever reason.  Example:

```json
{
	"type": "click",
	"selectors": [
		[ "aria/Logout" ]
	],
	"always": true
}
```

## Privacy

If you use any of the AI features, then the entire DOM tree of your visited pages are sent to the selected AI provider.  This may include sensitive information, especially if you type it into forms.  There are two ways to help mitigate this:

First, use the [Protect Sensitive Data](https://docs.stagehand.dev/v3/best-practices/prompting-best-practices#protect-sensitive-data) feature of Stagehand to use special placeholder macros for usernames, passwords, and other sensitive data.  Add these to your [Secret Vault](https://xyops.io/docs/secrets) and you can use the values via Stagehand's percent-wrapped syntax, e.g. `%USERNAME%`, `%PASSWORD%`, etc.  Also, set the "Verbose" selector to `0` to prevent these values from appearing in your job output.

The second thing you can do is run a local AI server in your infra, such as [Ollama](https://ollama.com/), and point to it via the "AI Base URL" parameter.  This will prevent all outbound requests, except of course the pages you navigate to, and perhaps some anonymous usage metrics broadcast by Chromium.

## Caching

### Browser Caching

To reduce browser network usage, and to retain things like cookies and user storage, you can utilize the built-in caching features of Chromium.  However, our Docker container is ephemeral and loses everything after each run (by design).  So, to retain the browser's user profile directory, you will need to create a volume bind so it shares a dir on the host.  This is not enabled by default for privacy concerns (i.e. leaking data outside the container).

To enable persistent browser caching, add this to your xyOps Plugin command, before the image name:

```
-v "$TMPDIR/xyplug-stagehand-profile:/app/profile"
```

### AI Caching

To reduce AI token usage, you can utilize the [Caching Actions](https://docs.stagehand.dev/v3/best-practices/caching) feature of Stagehand, which remembers the UI elements you target by storing a hash of the prompt.  However, our Docker container is ephemeral and loses everything after each run (by design).  So, to retain the cache directory, you will need to create a volume bind so it shares a dir on the host.  This is not enabled by default for privacy concerns (i.e. leaking data outside the container).

To enable persistent AI prompt caching, add this to your xyOps Plugin command, before the image name:

```
-v "$TMPDIR/xyplug-stagehand-ai-cache:/app/cache"
```

**Note:** If the website structure changes significantly, clear your cache directory to force fresh inference.

## Limitations

- Agent Mode: Stagehand's [Agent Mode](https://docs.stagehand.dev/v3/basics/agent) is currently not supported.
- Single-Page Only: Currently this plugin can only automate a single browser page / tab.
- Chromium Only: Currently this plugin only works with headless Chromium.

If there is enough interest we can add these features!  Let us know!

## Development

Here is how you can download the very latest dev build and install it manually:

```
git clone https://github.com/pixlcore/xyplug-stagehand.git
cd xyplug-stagehand
```

I highly recommend placing the following `.gitignore` file at the base of the project, if you plan on committing changes and sending pull requests:

```
.gitignore
/node_modules
```

## Testing

When invoked by xyOps the script expects JSON input via STDIN.  You can, however, fake this with a JSON file that you pipe into the script.  Example file:

```json
{
	"xy": 1,
	"params": {
		"ai_model_name": "google/gemini-2.5-flash",
		"ai_base_url": "",
		"ai_system_prompt": "",
		"ai_log_inference": true,
		"width": 1280,
		"height": 720,
		"video": "always",
		"verbose": 2,
		"aiTimeout": 60000,
		"domTimeout": 3000,
		"navTimeout": 30000,
		"script": "Navigate to https://news.ycombinator.com/\nExtract the first three article titles, in a JSON array."
	}
}
```

Example Dev setup:

```sh
# Build local docker image
docker build -t xyplug-stagehand-dev .

# Run with test file pipe, and index.js and downloads mapped to container
cat MY_TEST_FILE.json | docker run --rm -i --init --ipc=host -v "./downloads:/app/downloads" -v "./index.js:/app/index.js" -e AI_API_KEY="YOUR_AI_API_KEY_HERE" xyplug-stagehand-dev
```

## License

MIT
