/** Static vocabularies for the demo generator. No real people, no real stores. */

export const IT_FIRST = ["Giulia", "Marco", "Sara", "Luca", "Elena", "Francesco", "Chiara", "Alessandro", "Martina", "Davide", "Valentina", "Matteo", "Federica", "Andrea", "Silvia", "Lorenzo", "Alice", "Simone", "Beatrice", "Riccardo", "Paola", "Giorgio", "Irene", "Nicola", "Laura", "Stefano", "Marta", "Tommaso", "Anna", "Gabriele", "Roberta", "Daniele", "Camilla", "Pietro", "Serena", "Antonio", "Claudia", "Emanuele", "Noemi", "Filippo"];
export const IT_LAST = ["Rossi", "Russo", "Ferrari", "Esposito", "Bianchi", "Romano", "Colombo", "Ricci", "Marino", "Greco", "Bruno", "Gallo", "Conti", "De Luca", "Mancini", "Costa", "Giordano", "Rizzo", "Lombardi", "Moretti", "Barbieri", "Fontana", "Santoro", "Mariani", "Rinaldi", "Caruso", "Ferrara", "Galli", "Martini", "Leone", "Longo", "Gentile", "Martinelli", "Vitale", "Lombardo", "Serra", "Coppola", "De Santis", "D'Angelo", "Marchetti"];
export const EN_FIRST = ["Emily", "James", "Olivia", "Liam", "Ava", "Noah", "Sophia", "Mason", "Isabella", "Ethan", "Mia", "Lucas", "Charlotte", "Logan", "Amelia", "Benjamin", "Harper", "Elijah", "Evelyn", "Henry", "Abigail", "Jackson", "Ella", "Aiden", "Scarlett", "Daniel", "Grace", "Matthew", "Chloe", "Samuel", "Lily", "David", "Hannah", "Joseph", "Zoe", "Carter", "Nora", "Owen", "Riley", "Wyatt"];
export const EN_LAST = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Clark", "Lewis", "Robinson", "Walker", "Young", "Allen", "King", "Wright", "Scott", "Green", "Baker", "Adams", "Nelson", "Hill", "Campbell", "Mitchell", "Carter"];

export interface CityRow { city: string; zip: string; province?: string; country: string; weight: number }
export const IT_CITIES: CityRow[] = [
  { city: "Milano", zip: "20121", province: "MI", country: "IT", weight: 14 },
  { city: "Roma", zip: "00184", province: "RM", country: "IT", weight: 16 },
  { city: "Napoli", zip: "80133", province: "NA", country: "IT", weight: 9 },
  { city: "Torino", zip: "10121", province: "TO", country: "IT", weight: 7 },
  { city: "Bologna", zip: "40121", province: "BO", country: "IT", weight: 6 },
  { city: "Firenze", zip: "50122", province: "FI", country: "IT", weight: 5 },
  { city: "Palermo", zip: "90133", province: "PA", country: "IT", weight: 5 },
  { city: "Bari", zip: "70121", province: "BA", country: "IT", weight: 4 },
  { city: "Verona", zip: "37121", province: "VR", country: "IT", weight: 3 },
  { city: "Padova", zip: "35121", province: "PD", country: "IT", weight: 3 },
  { city: "Catania", zip: "95121", province: "CT", country: "IT", weight: 3 },
  { city: "Genova", zip: "16121", province: "GE", country: "IT", weight: 3 },
  { city: "Berlin", zip: "10115", country: "DE", weight: 5 },
  { city: "München", zip: "80331", country: "DE", weight: 3 },
  { city: "Paris", zip: "75001", country: "FR", weight: 5 },
  { city: "Lyon", zip: "69001", country: "FR", weight: 2 },
  { city: "Madrid", zip: "28001", country: "ES", weight: 4 },
  { city: "Barcelona", zip: "08001", country: "ES", weight: 3 },
];
export const US_CITIES: CityRow[] = [
  { city: "New York", zip: "10001", province: "NY", country: "US", weight: 14 },
  { city: "Los Angeles", zip: "90001", province: "CA", country: "US", weight: 11 },
  { city: "Chicago", zip: "60601", province: "IL", country: "US", weight: 8 },
  { city: "Houston", zip: "77001", province: "TX", country: "US", weight: 7 },
  { city: "Phoenix", zip: "85001", province: "AZ", country: "US", weight: 5 },
  { city: "Philadelphia", zip: "19101", province: "PA", country: "US", weight: 5 },
  { city: "San Diego", zip: "92101", province: "CA", country: "US", weight: 4 },
  { city: "Dallas", zip: "75201", province: "TX", country: "US", weight: 4 },
  { city: "Austin", zip: "73301", province: "TX", country: "US", weight: 4 },
  { city: "Seattle", zip: "98101", province: "WA", country: "US", weight: 4 },
  { city: "Denver", zip: "80201", province: "CO", country: "US", weight: 3 },
  { city: "Boston", zip: "02101", province: "MA", country: "US", weight: 4 },
  { city: "Miami", zip: "33101", province: "FL", country: "US", weight: 4 },
  { city: "Portland", zip: "97201", province: "OR", country: "US", weight: 3 },
  { city: "Toronto", zip: "M5H 2N2", province: "ON", country: "CA", weight: 4 },
  { city: "Vancouver", zip: "V6B 1A1", province: "BC", country: "CA", weight: 2 },
];
export const STREETS_IT = ["Via Roma", "Via Garibaldi", "Corso Italia", "Via Dante", "Via Mazzini", "Viale Europa", "Via Verdi", "Via Cavour", "Via Manzoni", "Piazza Duomo"];
export const STREETS_EN = ["Main St", "Oak Ave", "Maple Dr", "Cedar Ln", "Park Ave", "Washington Blvd", "Lake St", "Hill Rd", "Elm St", "Sunset Blvd"];

export interface ProductTemplate {
  title: string;
  type: string;
  options: { name: string; values: string[] }[];
  priceMinor: number;
  costRatio: number;
  popularity: number;
  /** vendor */
  vendor: string;
}

const SIZES_APPAREL = ["XS", "S", "M", "L", "XL"];
const COLORS = ["Black", "Navy", "Sand", "Olive", "Ivory", "Burgundy", "Grey", "Rust"];
export const APPAREL_TEMPLATES: ProductTemplate[] = [
  "Linen Shirt", "Oxford Shirt", "Merino Crewneck", "Cotton Tee", "Pima Polo", "Chino Trousers", "Pleated Skirt", "Denim Jacket", "Wool Coat", "Puffer Vest",
  "Silk Blouse", "Ribbed Cardigan", "Jersey Dress", "Wrap Dress", "Tailored Blazer", "Jogger Pants", "Cargo Shorts", "Hooded Sweatshirt", "Trench Coat", "Knit Beanie",
  "Cashmere Scarf", "Leather Belt", "Canvas Tote", "Relaxed Jeans", "Slim Jeans", "Corduroy Pants", "Fleece Pullover", "Rain Jacket", "Quilted Jacket", "Tank Top",
].map((title, i) => {
  const accessory = /Scarf|Belt|Tote|Beanie/.test(title);
  const base = accessory ? 3900 + (i % 5) * 1200 : 4900 + (i % 9) * 2200;
  return {
    title,
    type: accessory ? "Accessories" : /Dress|Skirt|Blouse/.test(title) ? "Womenswear" : /Jacket|Coat|Vest/.test(title) ? "Outerwear" : "Essentials",
    options: accessory ? [{ name: "Color", values: COLORS.slice(i % 4, (i % 4) + 3) }] : [{ name: "Size", values: SIZES_APPAREL }, { name: "Color", values: COLORS.slice(i % 5, (i % 5) + 2 + (i % 2)) }],
    priceMinor: base,
    costRatio: 0.32 + (i % 6) * 0.03,
    popularity: 0.4 + ((i * 7) % 10) / 10,
    vendor: ["Northwind Atelier", "Studio Nord", "Baltic Knitwear"][i % 3]!,
  };
});

const MATERIALS = ["Oak", "Walnut", "Ash", "Steel", "Brass"];
const FINISHES = ["Natural", "Matte Black", "Linen White", "Sage", "Terracotta"];
export const HOME_TEMPLATES: ProductTemplate[] = [
  "Ceramic Vase", "Linen Cushion", "Wool Throw", "Oak Side Table", "Pendant Lamp", "Table Lamp", "Stoneware Bowl Set", "Jute Rug", "Floating Shelf", "Candle Trio",
  "Serving Board", "Glass Carafe", "Wall Mirror", "Picture Frame", "Planter Pot", "Bath Towel Set", "Duvet Cover", "Pillowcase Pair", "Coat Rack", "Storage Basket",
].map((title, i) => {
  const furniture = /Table|Shelf|Rack|Mirror|Lamp|Rug/.test(title);
  const base = furniture ? 8900 + (i % 7) * 4500 : 2400 + (i % 6) * 1500;
  return {
    title,
    type: furniture ? "Furniture & Lighting" : /Towel|Duvet|Pillow|Throw|Cushion/.test(title) ? "Textiles" : "Decor",
    options: furniture ? [{ name: "Material", values: MATERIALS.slice(i % 3, (i % 3) + 2) }, { name: "Finish", values: FINISHES.slice(i % 4, (i % 4) + 2) }] : [{ name: "Color", values: FINISHES.slice(i % 3, (i % 3) + 3) }],
    priceMinor: base,
    costRatio: 0.38 + (i % 5) * 0.04,
    popularity: 0.4 + ((i * 3) % 10) / 10,
    vendor: ["Harbor Workshop", "Coastal Textiles", "Ember & Clay"][i % 3]!,
  };
});

export const CARRIERS_EU = ["DHL", "UPS", "BRT", "GLS", "Poste Italiane"];
export const CARRIERS_US = ["UPS", "FedEx", "USPS", "DHL"];

export const CAMPAIGN_ADJECTIVES = ["Always-on", "Spring", "Summer", "Autumn", "Holiday", "Black Friday", "New Arrivals", "Retargeting", "Prospecting", "Lookalike", "Catalog", "Bestsellers"];
export const CAMPAIGN_SUFFIX = ["Conversions", "Sales", "Traffic", "Advantage+", "PMax", "Search Brand", "Shopping"];

export const DISCOUNT_CODES: { code: string; type: "percentage" | "fixed_amount" | "free_shipping"; value: number; title: string }[] = [
  { code: "WELCOME10", type: "percentage", value: 1000, title: "Welcome 10%" },
  { code: "SPRING15", type: "percentage", value: 1500, title: "Spring 15%" },
  { code: "SUMMER20", type: "percentage", value: 2000, title: "Summer 20%" },
  { code: "FREESHIP", type: "free_shipping", value: 0, title: "Free shipping" },
  { code: "VIP25", type: "percentage", value: 2500, title: "VIP 25%" },
  { code: "BF30", type: "percentage", value: 3000, title: "Black Friday 30%" },
  { code: "TENOFF", type: "fixed_amount", value: 1000, title: "10 off" },
  { code: "COMEBACK15", type: "percentage", value: 1500, title: "Win-back 15%" },
  { code: "NEWSLETTER", type: "percentage", value: 1000, title: "Newsletter 10%" },
  { code: "FRIEND20", type: "fixed_amount", value: 2000, title: "Referral 20" },
  { code: "LOYAL12", type: "percentage", value: 1200, title: "Loyalty 12%" },
  { code: "GIFT5", type: "fixed_amount", value: 500, title: "Gift 5" },
];

export const RETURN_REASONS_IT = [
  { code: "wrong_size", label: "Taglia sbagliata", fault: "customer" },
  { code: "changed_mind", label: "Ho cambiato idea", fault: "customer" },
  { code: "defective", label: "Difettoso", fault: "merchant" },
  { code: "damaged", label: "Danneggiato nel trasporto", fault: "merchant" },
  { code: "not_as_described", label: "Non conforme alla descrizione", fault: "merchant" },
  { code: "wrong_item", label: "Articolo sbagliato", fault: "merchant" },
  { code: "other", label: "Altro", fault: "undetermined" },
];
export const RETURN_REASONS_EN = [
  { code: "wrong_size", label: "Wrong size or fit", fault: "customer" },
  { code: "changed_mind", label: "Changed my mind", fault: "customer" },
  { code: "defective", label: "Defective", fault: "merchant" },
  { code: "damaged", label: "Damaged in transit", fault: "merchant" },
  { code: "not_as_described", label: "Not as described", fault: "merchant" },
  { code: "wrong_item", label: "Wrong item received", fault: "merchant" },
  { code: "other", label: "Other", fault: "undetermined" },
];

/** Relative demand by calendar month (index 0 = January). */
export const SEASONALITY_APPAREL = [0.8, 0.75, 1.0, 1.05, 1.0, 0.9, 0.85, 0.7, 1.05, 1.15, 1.6, 1.4];
export const SEASONALITY_HOME = [0.85, 0.8, 0.95, 1.0, 1.15, 1.0, 0.9, 0.9, 1.0, 1.1, 1.5, 1.35];
export const WEEKDAY_WEIGHTS = [0.9, 1.1, 1.1, 1.05, 1.0, 0.85, 0.95];
export const HOUR_WEIGHTS = [1, 0.6, 0.4, 0.3, 0.3, 0.4, 0.8, 1.5, 2.2, 2.6, 2.7, 2.5, 2.4, 2.6, 2.7, 2.6, 2.4, 2.3, 2.6, 3.0, 3.2, 3.0, 2.4, 1.6];
