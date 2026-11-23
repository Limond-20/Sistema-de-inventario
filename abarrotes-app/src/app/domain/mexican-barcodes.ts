/**
 * Diccionario silencioso de códigos de barras frecuentes en abarrotes de México.
 *
 * NO precarga ningún producto al inventario ni al catálogo de la tienda:
 * únicamente sugiere nombre, categoría y unidad de venta cuando el usuario
 * escanea o escribe un código de barras al dar de alta un producto nuevo.
 */

import type { CatalogSaleUnit } from './catalog';

export interface KnownGroceryBarcodeItem {
  barcode: string;
  name: string;
  category: string;
  saleUnit: CatalogSaleUnit;
}

export const KNOWN_MEXICAN_GROCERY_BARCODES: readonly KnownGroceryBarcodeItem[] = [
  // ===================== BEBIDAS Y REFRESCOS =====================
  { barcode: '7501055300075', name: 'Coca-Cola Original 600ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055320639', name: 'Coca-Cola Sin Azúcar 600ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055300594', name: 'Coca-Cola Original 1.5L', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055302925', name: 'Coca-Cola Original 2L', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055305247', name: 'Coca-Cola Original 2.5L', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055321681', name: 'Coca-Cola Sin Azúcar 2.5L', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055313068', name: 'Coca-Cola Retornable', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501031311682', name: 'Pepsi 1.5L', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501022013861', name: 'Pepsi Black 355ml', category: 'Bebidas', saleUnit: 'Lata' },
  { barcode: '7501055307906', name: 'Agua Purificada Ciel 600ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501086801015', name: 'Agua Purificada Epura 1.5L', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055352388', name: 'Ciel Exprim Mandarina 600ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055352395', name: 'Ciel Exprim Mandarina 1L', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055352456', name: 'Ciel Exprim Limón 600ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055358885', name: 'Fuze Tea Té Negro 600ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055351237', name: 'Del Valle Naranja & Nada 600ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055351213', name: 'Del Valle Limón & Nada 600ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055356737', name: 'Néctar Del Valle Manzana 946ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055381463', name: 'Jugo Del Valle Piña 1L', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055360093', name: 'Jugo Del Valle Mango 200ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501055360079', name: 'Jugo Del Valle Naranja 200ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501013106930', name: 'Jugo Jumex Naranja 960ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501013105469', name: 'Jugo Jumex Naranja 960ml Clásico', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501013102765', name: 'Néctar Jumex Mango 475ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501013104714', name: 'Néctar Jumex Durazno 475ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501013100143', name: 'Jugo Jumex Único Fresco Manzana 200ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501031307210', name: 'Jumex Fresh Citrus 600ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501022010860', name: 'Jumex Frutzzo Mandarina 600ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501125104411', name: 'Suero Electrolit Coco 625ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501125144851', name: 'Suero Electrolit Uva 625ml', category: 'Bebidas', saleUnit: 'Pieza' },
  { barcode: '7501125174797', name: 'Suero Electrolit 625ml', category: 'Bebidas', saleUnit: 'Pieza' },

  // ===================== LÁCTEOS Y EMBUTIDOS =====================
  { barcode: '7501020515350', name: 'Leche Lala Entera 1L', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501020565935', name: 'Leche Lala Entera 1L Clásica', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501020565959', name: 'Leche Lala Semidescremada 1L', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501020548556', name: 'Leche Lala 100 Sin Lactosa 1L', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501020548495', name: 'Leche Lala 100 Proteína Deslactosada 1L', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501020550955', name: 'Leche Lala Deslactosada Light 1L', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501020553444', name: 'Leche Lala Deslactosada Light 1.5L', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501020547047', name: 'Leche Lala 1.8L', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501020547061', name: 'Leche Lala Deslactosada 1.8L', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501055900022', name: 'Leche Alpura Clásica 1L', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501055901425', name: 'Leche Alpura Deslactosada 1L', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501055904143', name: 'Leche Alpura Deslactosada Light 1L', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501055900800', name: 'Leche Alpura Light 1L', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501055909520', name: 'Crema Ácida Alpura 200ml', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501055905287', name: 'Media Crema Alpura 250ml', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501020513134', name: 'Crema Fresca Lala 200ml', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501020532258', name: 'Crema Lala Reducida en Grasa 900ml', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501020537970', name: 'Mantequilla Lala Sin Sal 90g', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501058611062', name: 'Leche Evaporada Carnation Clavel 360g', category: 'Lácteos', saleUnit: 'Lata' },
  { barcode: '7501032394820', name: 'Yoghurt Yoplait Fresa 1kg', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501032398439', name: 'Yoghurt Danone 900g', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501020563702', name: 'Yoghurt Lala Zero Natural 900g', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501040083617', name: 'Queso Panela Rebanado FUD 300g', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501040083709', name: 'Queso Panela en Bloque FUD 400g', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501040083884', name: 'Queso Manchego Rebanado FUD 190g', category: 'Lácteos', saleUnit: 'Pieza' },
  { barcode: '7501040005831', name: 'Jamón de Pavo Virginia FUD 290g', category: 'Embutidos', saleUnit: 'Pieza' },
  { barcode: '7501040003844', name: 'Jamón Virginia FUD 450g', category: 'Embutidos', saleUnit: 'Pieza' },
  { barcode: '7501040023491', name: 'Pechuga de Pavo San Rafael Balance 200g', category: 'Embutidos', saleUnit: 'Pieza' },
  { barcode: '7501020556445', name: 'Salchicha de Pavo Lala Plenia 500g', category: 'Embutidos', saleUnit: 'Pieza' },

  // ===================== PANADERÍA Y TORTILLAS =====================
  { barcode: '7441029502004', name: 'Pan Blanco Bimbo Grande 680g', category: 'Panadería', saleUnit: 'Pieza' },
  { barcode: '7501000111206', name: 'Pan Blanco Bimbo 620g', category: 'Panadería', saleUnit: 'Pieza' },
  { barcode: '7501030478409', name: 'Pan Integral Bimbo con Ajonjolí 567g', category: 'Panadería', saleUnit: 'Pieza' },
  { barcode: '7501000111503', name: 'Medias Noches Bimbo 340g', category: 'Panadería', saleUnit: 'Paquete' },
  { barcode: '7501030462293', name: 'Pan Tostado Bimbo Cero Cero 250g', category: 'Panadería', saleUnit: 'Paquete' },
  { barcode: '7501000112784', name: 'Nito Bimbo 62g', category: 'Panadería', saleUnit: 'Pieza' },
  { barcode: '7501030418399', name: 'Donitas Espolvoreadas Bimbo 140g', category: 'Panadería', saleUnit: 'Paquete' },
  { barcode: '7501030486664', name: 'Tortillinas Tía Rosa 561g', category: 'Panadería', saleUnit: 'Paquete' },
  { barcode: '7500810036624', name: 'Tortillas de Harina Tía Rosa 382g', category: 'Panadería', saleUnit: 'Paquete' },
  { barcode: '7501000157075', name: 'Tostadas Onduladas Milpa Real 360g', category: 'Panadería', saleUnit: 'Paquete' },
  { barcode: '7501000153107', name: 'Gansito Marinela 50g', category: 'Panadería', saleUnit: 'Pieza' },
  { barcode: '7501030480723', name: 'Choco Roles Marinela 160g', category: 'Panadería', saleUnit: 'Paquete' },
  { barcode: '7503029445126', name: 'Pingüinos Marinela 200g', category: 'Panadería', saleUnit: 'Paquete' },
  { barcode: '7501030474722', name: 'Barritas de Fresa Marinela 55g', category: 'Panadería', saleUnit: 'Paquete' },
  { barcode: '7501030490920', name: 'Polvorones Marinela 250g', category: 'Panadería', saleUnit: 'Paquete' },
  { barcode: '7500810003114', name: 'Canelitas Marinela 300g', category: 'Panadería', saleUnit: 'Paquete' },
  { barcode: '7500810011126', name: 'Galletas Príncipe Chocolate Marinela 126g', category: 'Panadería', saleUnit: 'Paquete' },

  // ===================== BOTANAS, GALLETAS Y DULCES =====================
  { barcode: '7501011101456', name: 'Sabritas Originales 42g', category: 'Botanas', saleUnit: 'Pieza' },
  { barcode: '7501011101463', name: 'Sabritas Adobadas 42g', category: 'Botanas', saleUnit: 'Pieza' },
  { barcode: '7501011101678', name: 'Sabritas Limón 46g', category: 'Botanas', saleUnit: 'Pieza' },
  { barcode: '7501011137431', name: 'Sabritas Habanero 42g', category: 'Botanas', saleUnit: 'Pieza' },
  { barcode: '7501011116252', name: 'Fritos Sabritas 53g', category: 'Botanas', saleUnit: 'Pieza' },
  { barcode: '7501011143999', name: 'Cheetos Nacho 52g', category: 'Botanas', saleUnit: 'Pieza' },
  { barcode: '7501011130272', name: 'Doritos Flamin Hot 61g', category: 'Botanas', saleUnit: 'Pieza' },
  { barcode: '7500478001620', name: 'Rancheritos Sabritas 40g', category: 'Botanas', saleUnit: 'Pieza' },
  { barcode: '7501030424536', name: 'Takis Fuego Barcel 56g', category: 'Botanas', saleUnit: 'Pieza' },
  { barcode: '7500810003671', name: 'Takis Fuego Barcel 70g', category: 'Botanas', saleUnit: 'Pieza' },
  { barcode: '7500810027837', name: 'Runners Chile Limón Barcel 72g', category: 'Botanas', saleUnit: 'Pieza' },
  { barcode: '7501000658923', name: 'Galletas Marías Gamesa 170g', category: 'Botanas', saleUnit: 'Paquete' },
  { barcode: '7501000655380', name: 'Galletas Marías Gamesa 510g', category: 'Botanas', saleUnit: 'Paquete' },
  { barcode: '7501000664221', name: 'Galletas Saladitas Gamesa 186g', category: 'Botanas', saleUnit: 'Paquete' },
  { barcode: '7500478014569', name: 'Galletas Chokis Clásica Gamesa 76g', category: 'Botanas', saleUnit: 'Paquete' },
  { barcode: '7501000140855', name: 'Galletas Triki Trakes Marinela 85g', category: 'Botanas', saleUnit: 'Paquete' },
  { barcode: '7506105606053', name: 'Chicles Trident Menta', category: 'Botanas', saleUnit: 'Paquete' },
  { barcode: '7506174512200', name: 'Chocolate Milky Way 48g', category: 'Botanas', saleUnit: 'Pieza' },

  // ===================== DESPENSA, ENLATADOS, ACEITES Y GRANOS =====================
  { barcode: '7501039121122', name: 'Aceite Nutrioli 850ml', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501039121610', name: 'Aceite de Soya Nutrioli 850ml', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501039120149', name: 'Aceite Nutrioli 946ml', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501039122099', name: 'Aceite Sabrosano 850ml', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501048103010', name: 'Aceite Puro de Canola Canoil 946ml', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501052410012', name: 'Arroz SOS Súper Extra 900g', category: 'Granos', saleUnit: 'Pieza' },
  { barcode: '7501018310103', name: 'Pasta La Moderna Fideo 200g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501018310530', name: 'Pasta La Moderna Spaghetti 200g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501018310257', name: 'Pasta La Moderna Letras 200g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501018310578', name: 'Pasta La Moderna Caracol 200g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501045403014', name: 'Atún Dolores en Agua 140g', category: 'Enlatados', saleUnit: 'Lata' },
  { barcode: '7501046401423', name: 'Atún Dolores en Aceite 140g', category: 'Enlatados', saleUnit: 'Lata' },
  { barcode: '7501045402970', name: 'Sardinas Dolores Salsa de Tomate 120g', category: 'Enlatados', saleUnit: 'Lata' },
  { barcode: '7501003789792', name: 'Atún Herdez en Agua 130g', category: 'Enlatados', saleUnit: 'Lata' },
  { barcode: '7501003129192', name: 'Atún Herdez en Agua 295g', category: 'Enlatados', saleUnit: 'Lata' },
  { barcode: '7501017004200', name: 'Chiles Jalapeños La Costeña 220g', category: 'Enlatados', saleUnit: 'Lata' },
  { barcode: '7501017004270', name: 'Frijoles Bayos Refritos La Costeña 580g', category: 'Enlatados', saleUnit: 'Lata' },
  { barcode: '7501017004423', name: 'Frijoles Negros Refritos La Costeña 580g', category: 'Enlatados', saleUnit: 'Lata' },
  { barcode: '7501071307782', name: 'Frijoles Refritos Bayos Isadora 430g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501071307799', name: 'Frijoles Refritos Negros Isadora 430g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501017005611', name: 'Puré de Tomate La Costeña 210g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501003105868', name: 'Puré de Tomate Herdez 1kg', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501003124234', name: 'Granos de Elote Herdez 220g', category: 'Enlatados', saleUnit: 'Lata' },
  { barcode: '7501003124319', name: 'Ensalada de Verduras Herdez 225g', category: 'Enlatados', saleUnit: 'Lata' },
  { barcode: '7501003303387', name: 'Mayonesa McCormick con Limón 468g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501052472133', name: 'Catsup Clemente Jacques 970g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501052474069', name: 'Mermelada de Fresa Clemente Jacques 270g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501005180658', name: 'Caldo de Pollo Knorr 100g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501058620101', name: 'Café Soluble Nescafé Clásico 120g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501058628466', name: 'Café Soluble Nescafé Decaf 40g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7506205802157', name: 'Alimento en Polvo Choco Milk 400g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501008057346', name: 'Cereal Zucaritas Kellogg’s 620g', category: 'Abarrotes', saleUnit: 'Pieza' },
  { barcode: '7501008041000', name: 'Cereal Corn Flakes Kellogg’s 500g', category: 'Abarrotes', saleUnit: 'Pieza' },

  // ===================== LIMPIEZA E HIGIENE =====================
  { barcode: '7501026006012', name: 'Jabón Zote Rosa 400g', category: 'Limpieza', saleUnit: 'Pieza' },
  { barcode: '7501026005985', name: 'Jabón Zote Rosa 100g', category: 'Limpieza', saleUnit: 'Pieza' },
  { barcode: '7501026005374', name: 'Jabón Zote Blanco 400g', category: 'Limpieza', saleUnit: 'Pieza' },
  { barcode: '7501035910041', name: 'Limpiador Fabuloso Mar Fresco 1L', category: 'Limpieza', saleUnit: 'Pieza' },
  { barcode: '7501025403058', name: 'Limpiador Multiusos Pinol 3.78L', category: 'Limpieza', saleUnit: 'Pieza' },
  { barcode: '7509546054650', name: 'Pasta Dental Colgate Luminous White 75ml', category: 'Higiene', saleUnit: 'Pieza' },
  { barcode: '7509546059723', name: 'Jabón Líquido Palmolive 700ml', category: 'Higiene', saleUnit: 'Pieza' },
  { barcode: '7509546074979', name: 'Jabón Corporal Palmolive Neutro Balance 150g', category: 'Higiene', saleUnit: 'Pieza' },
];

const KNOWN_BARCODE_MAP = new Map<string, KnownGroceryBarcodeItem>();
for (const entry of KNOWN_MEXICAN_GROCERY_BARCODES) {
  const clean = entry.barcode.trim();
  if (clean && !KNOWN_BARCODE_MAP.has(clean)) {
    KNOWN_BARCODE_MAP.set(clean, entry);
  }
}

/**
 * Busca un código de barras en el diccionario silencioso de abarrotes de México.
 * Normaliza códigos UPC-A de 12 dígitos / EAN-13 con cero inicial sin tocar el inventario.
 */
export function lookupKnownGroceryBarcode(rawCode: string): KnownGroceryBarcodeItem | null {
  const clean = String(rawCode || '').trim().replace(/\s+/g, '');
  if (!clean) return null;
  const direct = KNOWN_BARCODE_MAP.get(clean);
  if (direct) return direct;
  if (/^\d{12}$/.test(clean)) {
    return KNOWN_BARCODE_MAP.get(`0${clean}`) ?? null;
  }
  if (/^0\d{12}$/.test(clean)) {
    return KNOWN_BARCODE_MAP.get(clean.slice(1)) ?? null;
  }
  return null;
}
