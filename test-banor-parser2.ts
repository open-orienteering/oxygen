import * as fs from 'fs';
import { parseOCDCourseData } from './packages/api/src/ocd-course-parser.ts';

const fileData = fs.readFileSync('/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd');
const parsed = parseOCDCourseData(fileData);

const allIds = parsed.controls.map(c => c.id);
console.log("Controls:", allIds);

const c1 = parsed.courses[0];
console.log(`Course 1 starts with: ${c1.controls[0].controlId} ${JSON.stringify(c1.controls[0].mapPosition)}`);
console.log(`Course 1 ends with: ${c1.controls[c1.controls.length - 1].controlId} ${JSON.stringify(c1.controls[c1.controls.length - 1].mapPosition)}`);

console.log("Has STA1?", allIds.includes("STA1"));
