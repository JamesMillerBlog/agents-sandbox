#!/usr/bin/env node
import { main } from "../src/cli.mjs";

const exitCode = await main(process.argv.slice(2));
if (typeof exitCode === "number") process.exitCode = exitCode;
