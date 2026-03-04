/**
 * GDPR-safe fictional data for the Test Lab.
 *
 * Names are common Swedish names that do not correspond to any specific
 * real person when combined randomly. Club names are public entities
 * (registered associations) and pose no GDPR concern.
 */

export const MALE_FIRST_NAMES = [
  "Erik", "Lars", "Anders", "Karl", "Johan", "Per", "Nils", "Ove",
  "Stig", "Gunnar", "Bengt", "Lennart", "Göran", "Sven", "Olof",
  "Hans", "Bo", "Jan", "Ulf", "Leif", "Mats", "Björn", "Magnus",
  "Rolf", "Arne", "Peter", "Tommy", "Christer", "Ingemar", "Torbjörn",
  "Henrik", "Fredrik", "Mikael", "Stefan", "Daniel", "Thomas", "Andreas",
  "Martin", "Mattias", "Jonas", "Marcus", "Patrik", "Oscar", "Simon",
  "Gustav", "Alexander", "Viktor", "Emil", "Axel", "Rasmus",
  "Niklas", "Tobias", "David", "Jakob", "Filip", "Linus", "Robin",
  "Sebastian", "Adam", "Elias", "Oliver", "Hugo", "William", "Noah",
  "Lucas", "Albin", "Kevin", "Anton", "Isak", "Ludvig",
  "Arvid", "Edvin", "Theo", "Leo", "Noel", "Viggo", "Melvin",
  "Alfred", "Valter", "Einar", "Sixten", "Folke", "Ture", "Helge",
  "Ivar", "Ragnar", "Vilhelm", "Bertil", "Erling", "Holger", "Algot",
  "Rune", "Tore", "Claes", "Håkan", "Ingvar", "Kent", "Kjell",
  "Roger", "Roland", "Åke", "Örjan",
];

export const FEMALE_FIRST_NAMES = [
  "Anna", "Maria", "Eva", "Karin", "Lena", "Sara", "Lisa", "Ingrid",
  "Birgitta", "Margareta", "Christina", "Elisabeth", "Kristina", "Marie",
  "Kerstin", "Gun", "Britt", "Ulla", "Annika", "Inga", "Barbro",
  "Marianne", "Monica", "Elin", "Emma", "Hanna", "Ida", "Julia",
  "Maja", "Amanda", "Linnéa", "Matilda", "Johanna", "Sofia", "Frida",
  "Klara", "Tilda", "Felicia", "Wilma", "Ebba", "Saga", "Ellen",
  "Astrid", "Elsa", "Agnes", "Alice", "Olivia", "Alma", "Stella",
  "Vera", "Selma", "Iris", "Signe", "Ester", "Tyra", "Edith",
  "Greta", "Märta", "Helga", "Dagny", "Solveig", "Gudrun", "Hillevi",
  "Berit", "Gunilla", "Sonja", "Yvonne", "Carina", "Camilla", "Helena",
  "Susanne", "Malin", "Jenny", "Therese", "Sandra", "Jessica", "Veronica",
  "Ulrika", "Linda", "Petra", "Åsa", "Cecilia", "Katarina", "Louise",
  "Nathalie", "Rebecka", "Vendela", "Lovisa", "Emilia", "Filippa",
  "Hedvig", "Elvira", "Meja", "Tuva", "Molly", "Alva", "Nora",
  "Stina", "Pia",
];

export const LAST_NAMES = [
  "Andersson", "Johansson", "Karlsson", "Nilsson", "Eriksson", "Larsson",
  "Olsson", "Persson", "Svensson", "Pettersson", "Gustafsson", "Jonsson",
  "Jansson", "Hansson", "Bengtsson", "Jönsson", "Lindberg", "Jakobsson",
  "Magnusson", "Lindström", "Olofsson", "Lindgren", "Axelsson", "Berg",
  "Bergström", "Lundberg", "Lind", "Lundgren", "Lundqvist", "Mattsson",
  "Berglund", "Fredriksson", "Sandberg", "Henriksson", "Forsberg",
  "Sjöberg", "Wallin", "Engström", "Eklund", "Danielsson", "Lundin",
  "Håkansson", "Björk", "Bergman", "Gunnarsson", "Holm", "Wikström",
  "Samuelsson", "Isaksson", "Fransson", "Martinsson", "Öberg", "Norberg",
  "Sundberg", "Söderberg", "Mårtensson", "Lindqvist", "Ström", "Nyström",
  "Holmberg", "Sundström", "Dahlberg", "Ekström", "Sjögren", "Holmgren",
  "Sundqvist", "Blomqvist", "Nordström", "Eliasson", "Nyberg", "Claesson",
  "Hermansson", "Abrahamsson", "Sandström", "Lund", "Nordin", "Borg",
  "Hedlund", "Sjöström", "Åberg", "Åström", "Berger", "Forslund",
  "Nordberg", "Hellström", "Holmqvist", "Nyman", "Moberg", "Ahlström",
  "Björklund", "Söderlund", "Nygren", "Hallberg", "Edlund", "Berggren",
  "Vestberg", "Granlund", "Ågren", "Engberg", "Hedberg", "Lidén",
  "Ekberg", "Hallström", "Backman", "Vikström", "Lindblom", "Malmberg",
  "Dahlström", "Boman", "Hedström", "Brännström", "Söderström", "Viklund",
  "Granberg", "Höglund", "Wahlström", "Ökvist", "Tjärnberg", "Lejon",
];

export interface FictionalClub {
  id: number;
  name: string;
  shortName: string;
}

export const CLUBS: FictionalClub[] = [
  { id: 100001, name: "Degerfors OK", shortName: "Deg" },
  { id: 100002, name: "Ankarsrums OK", shortName: "Ank" },
  { id: 100003, name: "Bodafors OK", shortName: "Bod" },
  { id: 100004, name: "Burseryds IF", shortName: "Bur" },
  { id: 100005, name: "Domnarvets GOIF", shortName: "Dom" },
  { id: 100006, name: "Gamleby OK", shortName: "Gam" },
  { id: 100007, name: "Grangärde OK", shortName: "Gra" },
  { id: 100008, name: "Halmstad OK", shortName: "Hal" },
  { id: 100009, name: "Hedesunda IF", shortName: "Hed" },
  { id: 100010, name: "OK Forsarna", shortName: "For" },
  { id: 100011, name: "Hultsfreds OK", shortName: "Hul" },
  { id: 100012, name: "Häverödals SK", shortName: "Häv" },
  { id: 100013, name: "IFK Kiruna", shortName: "Kir" },
  { id: 100014, name: "Kjula IF", shortName: "Kju" },
  { id: 100015, name: "Krokeks OK", shortName: "Kro" },
  { id: 100016, name: "Laxå OK", shortName: "Lax" },
  { id: 100017, name: "Ljusne-Ala OK", shortName: "LjA" },
  { id: 100018, name: "Niilivaara IS", shortName: "Nii" },
  { id: 100019, name: "Nyköpings OK", shortName: "Nyk" },
  { id: 100020, name: "Robertsfors IK", shortName: "Rob" },
  { id: 100021, name: "OK Roto", shortName: "Rot" },
  { id: 100022, name: "Sigtuna OK", shortName: "Sig" },
  { id: 100023, name: "Skellefteå OK", shortName: "Ske" },
  { id: 100024, name: "FK Snapphanarna", shortName: "Sna" },
  { id: 100025, name: "IK Surd", shortName: "Sur" },
  { id: 100026, name: "OK Tranan", shortName: "Tra" },
  { id: 100027, name: "Stora Tuna OK", shortName: "StT" },
  { id: 100028, name: "Uddevalla OK", shortName: "Udd" },
  { id: 100029, name: "Visby OK", shortName: "Vis" },
  { id: 100030, name: "Åsele OK", shortName: "Åse" },
  { id: 100031, name: "Skogsluffarna", shortName: "Sko" },
];

/** SI card number ranges per card type, with relative weights */
export const SI_CARD_RANGES: { type: string; min: number; max: number; weight: number }[] = [
  { type: "SI5", min: 100000, max: 499999, weight: 10 },
  { type: "SI8", min: 2000001, max: 2999999, weight: 15 },
  { type: "SI9", min: 1000001, max: 1999999, weight: 10 },
  { type: "SI10", min: 7000001, max: 7999999, weight: 25 },
  { type: "SIAC", min: 8000001, max: 8999999, weight: 40 },
];
