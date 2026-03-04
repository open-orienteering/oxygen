import * as fs from 'fs';
import { parseOCDCourseData } from './packages/api/src/ocd-course-parser.ts';

const fileData = fs.readFileSync('e2e/test.ocd');
const parsed = parseOCDCourseData(fileData);
console.log("M1:", parsed.controls.find(c => c.id === 'M1'));
