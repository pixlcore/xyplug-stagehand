// Stagehand wrapper for xyOps
// Copyright (c) 2025 PixlCore LLC
// MIT License

import { Stagehand } from "@browserbasehq/stagehand";
import { chromium } from "playwright-core";
import { z } from "zod";
import { globSync, unlinkSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename } from 'node:path';

globalThis.AI_SDK_LOG_WARNINGS = false;

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
};

const app = {
	
	job: null,
	params: null,
	stagehand: null,
	browser: null,
	context: null,
	page: null,
	output: {},
	captures: [],
	steps: [],
	stepIdx: 0,
	
	async run() {
		// read in data from xyops
		const chunks = [];
		for await (const chunk of process.stdin) { chunks.push(chunk); }
		let job = this.job = JSON.parse( chunks.join('') );
		let params = this.params = job.params;
		
		// apply defaults and normalization on some params
		params.verbose = parseInt( params.verbose || 0 );
		params.width = parseInt( params.width || 1280 );
		params.height = parseInt( params.height || 720 );
		params.domTimeout = parseInt( params.domTimeout || 3000 );
		params.navTimeout = parseInt( params.navTimeout || 30000 );
		params.stepDelay = parseInt( params.stepDelay || 1000 );
		params.video = ('' + params.video).toLowerCase() || 'none';
		
		this.logVerbose("Job Parameters: " + JSON.stringify(params));
		
		// setup stagehand opts
		let sh_opts = {
			env: "LOCAL",
			model: {
				modelName: params.ai_model || 'google/gemini-2.5-flash',
				apiKey: params.ai_api_key || ''
			},
			verbose: params.verbose || 0,
			cacheDir: "cache",
			logInferenceToFile: params.ai_log_inference || false,
			domSettleTimeout: params.domTimeout,
			
			localBrowserLaunchOptions: {
				executablePath: globSync('/ms-playwright/chromium-*/chrome-linux/chrome')[0],
				headless: true,
				viewport: { 
					width: params.width || 1280,
					height: params.height || 720
				},
				deviceScaleFactor: params.scale || 1.0, // Display scaling
				ignoreHTTPSErrors: params.ssl_cert_bypass || false, // Ignore certificate errors
				locale: params.locale || 'en-US', // Set browser language
				downloadsPath: './downloads', // Download directory
				acceptDownloads: true, // Allow downloads
				
				args: [
					// "--remote-debugging-port=9222",
					// "--remote-debugging-address=127.0.0.1",
					"--no-sandbox",
					"--disable-setuid-sandbox",
					"--disable-dev-shm-usage",
					"--disable-gpu",

					// Playwright usually adds these automatically; safe either way:
					"--disable-background-networking",
					"--no-first-run",
					"--no-default-browser-check",
					"--disable-features=TranslateUI",
				],
				
				// Optional: your own Chrome profile dir
				userDataDir: "./profile",
				// keep it between runs
				preserveUserDataDir: true,
			}
		};
		
		if (params.ai_base_url) {
			opts.model.baseURL = params.ai_base_url;
		}
		if (params.ai_system_prompt) {
			opts.systemPrompt = params.ai_system_prompt;
		}
		
		// make sure downloads dir exists
		if (!existsSync('downloads')) mkdirSync('downloads');
		
		// at vebose level 2, dump job data and env to downloads
		if (params.verbose >= 2) {
			fs.writeFileSync( 'downloads/job.json', JSON.stringify(job, null, "\t") + "\n" );
			fs.writeFileSync( 'downloads/env.json', JSON.stringify(process.env, null, "\t") + "\n" );
		}
		
		console.log(`🔵 Initializing Stagehand...`);
		this.logVerbose( "Stagehand Config: " + JSON.stringify(sh_opts) );
		
		// init stagehand
		let stagehand = this.stagehand = new Stagehand(sh_opts);
		await stagehand.init();
		
		// Connect Playwright to Stagehand's browser
		let browser = this.browser = await chromium.connectOverCDP({
			wsEndpoint: stagehand.connectURL(),
		});
		
		var ctx_opts = {};
		if (params.video != 'none') {
			ctx_opts.recordVideo = {
				dir: 'downloads',
				size: {
					width: params.width || 1280,
					height: params.height || 720
				},
			};
		}
		let context = this.context = await browser.newContext(ctx_opts);
		let page = this.page = await context.newPage();
		
		page.setDefaultTimeout( params.domTimeout );
		page.setDefaultNavigationTimeout( params.navTimeout );
		
		context.on("response", async (res) => {
			const url = res.url();
			const status = res.status();
			const headers = res.headers();
			
			this.logVerbose(`🌎 Network Request [${status}] ${url}`);
			
			let step = this.captures.find( (step) => {
				return !!url.includes( step.url );
			} );
			if (!step) return;
			
			if (!this.output.captures) this.output.captures = [];
			let capture = { url, status, headers };
			let data = null;
			
			console.log(`🟢 Request Captured [${res.status()}] ${url}`);
			
			try {
				const ct = headers["content-type"] || "";
				if (ct.includes("application/json")) {
					data = await res.json();
					this.logVerbose( "JSON Captured: " + JSON.stringify(data) );
				}
				else {
					data = await res.text();
					this.logVerbose( "Text Captured: " + data );
				}
			} 
			catch (e) {
				console.error("🛑 Error reading response body: ", e.message);
			}
			
			if (step.download) {
				// download as file
				var file = 'downloads/' + url.replace(/^\w+\:\/\/[^\/]+\//, '').replace(/\/$/, '').replace(/[^\w\-\.]+/g, '_').toLowerCase();
				
				if (!file.match(/\.\w+$/) && headers["content-type"] && headers["content-type"].match(/^\w+\/(\w+)/)) {
					file += '.' + RegExp.$1;
				}
				
				var payload = data;
				if (typeof(data) == 'object') {
					payload = step.pretty ? JSON.stringify(data, null, "\t") : JSON.stringify(data);
					payload += "\n";
				}
				
				writeFileSync( file, payload );
				capture.filename = basename(file);
			}
			else {
				// include in job data
				capture.response = data;
			}
			
			this.output.captures.push(capture);
		});
		
		await this.compileScript();
		if (!this.steps.length) throw new Error("Cannot run script: No steps found.");
		
		await this.runScript();
		await this.finish();
	},
	
	async compileScript() {
		// compile text script into JSON, if needed
		const params = this.params;
		
		// if script is already an object, we done
		if ((typeof(params.script) == 'object')) {
			this.steps = params.script.steps || [];
			return;
		}
		
		// if script is already json-text, just parse it
		if (params.script.trim().match(/^\{[\S\s]+\}$/)) {
			params.script = JSON.parse( params.script );
			this.steps = params.script.steps;
			return;
		}
		
		// parse as line-delimited instructions
		params.script.trim().split(/\n/).forEach( (line) => {
			line = line.trim();
			if (!line.match(/^\w/)) return; // ignore blanks and comments
			
			if (line.match(/^navigate\:?\s+(to\s+)?(\S+)$/i)) {
				this.steps.push({ type: 'navigate', url: RegExp.$2 });
			}
			else if (line.match(/^capture\:?\s+(\S+)$/i)) {
				this.steps.push({ type: 'capture', url: RegExp.$1 });
			}
			else if (line.match(/^extract\:?\s+/i)) {
				this.steps.push({ type: 'extract', prompt: line });
			}
			else if (line.match(/^evaluate\:?\s+(.+)$/i)) {
				this.steps.push({ type: 'evaluate', script: RegExp.$1 });
			}
			else if (line.match(/^sleep\:?\s+(for\s+)?(\d+)$/i)) {
				this.steps.push({ type: 'sleep', duration: parseInt(RegExp.$1) });
			}
			else {
				this.steps.push({ type: 'action', prompt: line });
			}
		} );
	},
	
	async runScript() {
		// here we go, run all steps
		for (const step of this.steps) {
			await this.runStep(step);
		}
	},
	
	async runStep(step) {
		// run a single step
		let func = 'runStep_' + step.type;
		if (!this[func]) {
			// throw new Error("Unknown step type: " + step.type);
			this.logWarning( `Skipping unknown step type: ` + step.type );
			return;
		}
		
		const prefix = `🔵 Step ${ Math.floor(this.stepIdx + 1) }/${ this.steps.length }: `;
		
		switch (step.type) {
			case 'navigate': console.log( prefix + `Navigating to: ` + step.url ); break;
			case 'capture': console.log( prefix + `Capturing network requests for: ` + step.url ); break;
			case 'action': console.log( prefix + `Taking action: ` + step.prompt ); break;
			case 'extract': console.log( prefix + `Extracting data: ` + step.prompt ); break;
			case 'setViewport': console.log( prefix + `Setting viewport size: ` + step.width + 'x' + step.height ); break;
			case 'click': console.log( prefix + `Clicking on: ` + step.selectors.join(', ') ); break;
			case 'doubleClick': console.log( prefix + `Double-clicking on: ` + step.selectors.join(', ') ); break;
			case 'change': console.log( prefix + `Changing form element: ` + step.selectors.join(', ') + ` to: ` + step.value ); break;
			case 'keyDown': console.log( prefix + `Pressing key: ` + step.key ); break;
			case 'keyUp': console.log( prefix + `Releasing key: ` + step.key ); break;
			case 'text': console.log( prefix + `Typing text: ` + (step.text ?? step.value) ); break;
			case 'evaluate': console.log( prefix + `Evaluating JavaScript: ` + step.script ); break;
			case 'reload': console.log( prefix + `Reloading page.` ); break;
			case 'sleep': console.log( prefix + `Sleeping for ${step.duration}ms.` ); break;
			case 'waitFor': console.log( prefix + `Waiting for: ` + step.selectors.join(', ') ); break;
		}
		
		await this[func](step);
		
		// update progress
		this.stepIdx++;
		if (this.job.xy) console.log( JSON.stringify({ xy:1, progress:this.stepIdx / this.steps.length }) );
		
		// sanity sleep between steps
		await sleep( this.params.stepDelay );
	},
	
	async runStep_navigate(step) {
		// nav to new url
		// step: { url, timeout?, waitUntil? }
		if (!step.url || (typeof(step.url) != 'string') || !step.url.match(/^\w+\:\/\/\S+$/)) {
			throw new Error("Navigate: Invalid URL: " + step.url);
		}
		
		await this.page.goto( step.url, { timeout: step.timeout || this.params.navTimeout, waitUntil: step.waitUntil || "load" } );
	},
	
	async runStep_reload(step) {
		// reload current page
		// step: { timeout?, waitUntil? }
		await this.page.reload({ timeout: step.timeout || this.params.navTimeout, waitUntil: step.waitUntil || 'load' });
	},
	
	async runStep_capture(step) {
		// add network capture
		// step: { url }
		if (!step.url || (typeof(step.url) != 'string')) {
			throw new Error("Capture: Invalid match: " + step.url);
		}
		this.captures.push( step );
	},
	
	async runStep_action(step) {
		// take action using AI
		// step: { prompt, timeout? }
		if (!step.prompt) throw new Error("Action: No prompt specified.");
		
		let result = await this.stagehand.act( step.prompt, { 
			variables: process.env, 
			timeout: step.timeout || this.params.domTimeout,
			page: this.page 
		} );
		if (!result || !result.success) throw new Error("Action failed: " + result.actionDescription + ": " + result.message);
	},
	
	async runStep_extract(step) {
		// extract data using AI
		// step: { prompt, timeout? }
		if (!step.prompt) throw new Error("Extract: No prompt specified.");
		
		const result = await this.stagehand.extract( step.prompt, z.any(), { page: this.page, timeout: step.timeout || this.params.domTimeout });
		if (!result) throw new Error("Extraction failed: " + step.prompt);
		
		if (!this.output.extractions) this.output.extractions = [];
		
		this.output.extractions.push({ 
			prompt: step.prompt,
			result: result
		});
	},
	
	async runStep_setViewport(step) {
		// change viewport size
		// step: { width, height }
		if (!step.width || !step.height) throw new Error("setViewPort: width and/or height missing.");
		
		await this.page.setViewportSize({ width, height });
	},
	
	async runStep_click(step) {
		// click the mouse on a target
		// step: { selectors, offsetX?, offsetY? }
		var locator = this.buildLocatorFromStep(step);
		
		const clickOptions = {
			timeout: this.params.domTimeout,
		};
		
		// DevTools uses offsetX/offsetY; Playwright uses position: { x, y }
		if (typeof step.offsetX === "number" && typeof step.offsetY === "number") {
			clickOptions.position = { x: step.offsetX, y: step.offsetY };
		}
		
		await locator.click(clickOptions);
	},
	
	async runStep_doubleClick(step) {
		// double-click the mouse on a target
		// step: { selectors, offsetX?, offsetY? }
		var locator = this.buildLocatorFromStep(step);
		
		const clickOptions = {
			timeout: this.params.domTimeout,
		};
		
		// DevTools uses offsetX/offsetY; Playwright uses position: { x, y }
		if (typeof step.offsetX === "number" && typeof step.offsetY === "number") {
			clickOptions.position = { x: step.offsetX, y: step.offsetY };
		}
		
		await locator.dblclick(clickOptions);
	},
	
	async runStep_change(step) {
		// change a form element's value
		// step: { selectors, value }
		var locator = this.buildLocatorFromStep(step);
		let value = step.value ?? "";
		
		// handle stagehand-style %placeholder% variables
		value = value.toString().replace( /\%(\w+)\%/g, function(m_all, m_g1) {
			if (!process.env[ m_g1 ]) throw new Error("Environment variable not found: " + m_g1);
			return process.env[ m_g1 ];
		} );
		
		await locator.fill(value, { timeout: this.params.domTimeout });
	},
	
	async runStep_keyDown(step) {
		// simulate pressing a key
		// step: { key }
		if (!step.key) throw new Error("keyDown: Missing key to hit.");
		
		await this.page.keyboard.down(step.key);
	},
	
	async runStep_keyUp(step) {
		// simulate releasing a key
		// step: { key }
		if (!step.key) throw new Error("keyUp: Missing key to release.");
		
		await this.page.keyboard.up(step.key);
	},
	
	async runStep_text(step) {
		// simulate typing a text string
		// step: { text }
		if (!step.text) throw new Error("Text: Missing text to enter.");
		
		let value = step.text ?? step.value;
		
		// handle stagehand-style %placeholder% variables
		value = value.toString().replace( /\%(\w+)\%/g, function(m_all, m_g1) {
			if (!process.env[ m_g1 ]) throw new Error("Environment variable not found: " + m_g1);
			return process.env[ m_g1 ];
		} );
		
		await this.page.keyboard.insertText( value );
	},
	
	async runStep_evaluate(step) {
		// run a JavaScript code snippet
		// step: { script }
		if (!step.script) throw new Error("Evaluate: Missing script code to execute.");
		
		let value = step.script;
		
		// handle stagehand-style %placeholder% variables
		value = value.toString().replace( /\%(\w+)\%/g, function(m_all, m_g1) {
			if (!process.env[ m_g1 ]) throw new Error("Environment variable not found: " + m_g1);
			return process.env[ m_g1 ];
		} );
		
		const result = await this.page.evaluate( value );
		
		if (!this.output.evaluations) this.output.evaluations = [];
		this.output.evaluations.push({
			script: step.script,
			result: result
		});
	},
	
	async runStep_sleep(step) {
		// sleep for the specified interval
		// step: { delay }
		if (!step.duration) throw new Error("Sleep: Missing duration (ms) to sleep for.");
		
		await sleep( step.duration );
	},
	
	async runStep_waitFor(step) {
		// wait for selectors to be visible
		// step: { selectors, state?, timeout? }
		var locator = this.buildLocatorFromStep(step);
		
		await locator.waitFor({
			state: step.state || 'visible',
			timeout: step.timeout || this.params.domTimeout
		});
	},
	
	/**
	 * Map a single raw Chrome selector string (e.g. "aria/Username")
	 * to a Playwright Locator.
	 */
	locatorFromSelector(rawSelector) {
		if (!rawSelector || typeof rawSelector !== "string") return null;
		let page = this.page;
		
		// Normalize 'pierce/' (Chrome's deep selector) by stripping the prefix.
		// We lose the shadow-boundary semantics, but in many apps it's still fine.
		if (rawSelector.startsWith("pierce/")) {
			rawSelector = rawSelector.slice("pierce/".length);
		}
		
		// 1) aria/ label → getByLabel (good for "Username", "Email Address", etc.)
		if (rawSelector.startsWith("aria/")) {
			const name = rawSelector.slice("aria/".length).trim();
			if (!name || name === "*") return null;
			return page.getByLabel(name);
		}
		
		// 2) text/ → getByText
		if (rawSelector.startsWith("text/")) {
			const text = rawSelector.slice("text/".length);
			// Chrome sometimes uses "text/*" as a wildcard; skip those
			if (!text || text === "*") return null;
			return page.getByText(text, { exact: false });
		}
		
		// 3) xpath/ or xpath// → locator('xpath=...')
		if (rawSelector.startsWith("xpath/")) {
			// Normalize xpath//... → //...
			const expr = rawSelector.replace(/^xpath\/+/, "//");
			return page.locator(`xpath=${expr}`);
		}
		
		// 4) explicit XPath looking selector (starts with // or (//)
		if (rawSelector.startsWith("//") || rawSelector.startsWith("(//")) {
			return page.locator(`xpath=${rawSelector}`);
		}
		
		// 5) Chrome CSS "pierce" selectors with >>>; Playwright uses >> for deep
		if (rawSelector.includes(">>>")) {
			const converted = rawSelector.replace(/>>>/g, ">>");
			return page.locator(converted);
		}
		
		// 6) catch-all: treat as CSS selector
		return page.locator(rawSelector);
	},

	/**
	 * Build a single Playwright Locator from a DevTools selector list:
	 *	 "selectors": [ ["aria/Email Address"], ["#LoginEmail"], ["xpath///*[@id=\"LoginEmail\"]"] ]
	 */
	buildLocatorFromStep(step) {
		if (!step.selectors || !Array.isArray(step.selectors)) {
			throw new Error(`Step of type '${step.type}' has no selectors`);
		}
		
		const locators = [];
		
		for (const selectorGroup of step.selectors) {
			if (!Array.isArray(selectorGroup) || selectorGroup.length === 0) continue;
			// DevTools uses an array of candidate strings per "group".
			// We’ll just take the first one in each group; you could get fancier here.
			const raw = selectorGroup[0];
			const loc = this.locatorFromSelector(raw);
			if (loc) locators.push(loc);
		}
		
		if (!locators.length) {
			throw new Error(`Could not build any locator for step type: ${step.type}`);
		}
		
		// Chain them with .or() so whichever resolves can be used.
		let combined = locators[0];
		for (let i = 1; i < locators.length; i++) {
			combined = combined.or(locators[i]);
		}
		
		// To avoid strict-mode multi-match errors, just take the first match
		return combined.first();
	},
	
	async archiveInferenceLog() {
		// if present, compress inference logs into archive in downloads dir
		if (!this.params || !this.params.ai_log_inference) return;
		if (!existsSync('inference_summary')) return;
		
		this.logVerbose( 
			execSync('/bin/tar zcf ./downloads/inference_summary.tar.gz ./inference_summary/*', { encoding: 'utf8' }) 
		);
	},
	
	async finish() {
		// finish up
		let params = this.params;
		
		// did we capture a video?
		let video_path = '';
		if (params.video != 'none') {
			video_path = await this.page.video().path();
		}
		
		// close things
		await this.context.close();
		await this.stagehand.close();
		
		// if user only wants video on error, delete it now
		if (video_path && (params.video != 'always')) {
			try { unlinkSync( video_path ); }
			catch (err) { this.logWarning(`Failed to delete video file: ` + err); }
		}
		
		// if user asked for logInferenceToFile, we need to tarball it up
		if (params.ai_log_inference) {
			await this.archiveInferenceLog();
		}
		
		console.log ( `✅ Completed all steps.` );
		
		// complete xyops job
		if (this.job.xy) console.log( JSON.stringify({ 
			xy: 1, 
			code: 0,
			description: 'Success',
			data: this.output, 
			files: [ 'downloads/*' ] 
		}) );
	},
	
	logWarning(msg) {
		// only log if verbose mode is non-zero
		console.error(`🟠 Warning: ` + msg);
	},
	
	logVerbose(msg) {
		// only log if verbose mode is non-zero
		if (this.params.verbose) console.log(msg);
	}
	
}; // app

app.run().catch( async (err) => {
	// universal error catch
	console.error( `🛑 Error: ` + err, err );
	
	if (app.context) await app.context.close();
	if (app.stagehand) await app.stagehand.close();
	
	await app.archiveInferenceLog();
	
	if (app.job && app.job.xy) console.log( JSON.stringify({ 
		xy: 1, 
		code: 1, 
		description: '' + err,
		data: app.output, 
		files: [ 'downloads/*' ] 
	}) );
	
	process.exit(1);
});
