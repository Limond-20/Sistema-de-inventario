# Clasificación ABC adaptativa

Cada tienda vende cosas distintas. La leche puede ser Clase A en una tienda de colonia y Clase B en una que está junto a un Oxxo. Por eso la clase **no se captura a mano en el catálogo**: el sistema la calcula con las ventas de cada tienda, y el tendero solo confirma o corrige.

Código: `abarrotes-app/src/app/services/abc-classifier.ts`
Pantalla: `/clasificacion` (botón **🏷️ Clasificar A, B, C** en el Catálogo)

---

## 1. Tres formas de asignar la clase (en orden de prioridad)

| Prioridad | Fuente | Cuándo aplica | Cómo se decide |
|---|---|---|---|
| 1 | 🔒 **MANUAL** | El tendero fijó la clase con candado | Se respeta siempre. El sistema solo avisa si sus números dicen otra cosa. |
| 2 | 🤖 **AUTOMÁTICA** | El producto tiene **14 días o más** de ventas registradas | Pareto con las ventas reales de los últimos 30 días |
| 3 | 🙋 **GUIADA** | Tienda nueva, o producto con menos de 14 días | 2 preguntas con botones grandes; la clase es **provisional** |

El paso natural es: la tienda arranca **guiada** el día que se instala, a las 2 semanas pasa sola a **automática**, y el tendero pone **candado** solo donde no está de acuerdo.

---

## 2. Modo automático (Pareto con ventas reales)

### ¿Qué se mide?

Un **puntaje combinado** por producto, con datos del Kardex (cada venta del POS):

```
puntaje = 0.7 × (ganancia del producto / ganancia total)
        + 0.3 × (tickets donde aparece / tickets totales)
```

- **Ganancia, no ventas en pesos.** Un producto caro con margen apretado (el aceite cuando sube el costo) puede vender mucho y dejar poco. Lo que le importa al tendero es lo que le queda.
- **Tickets (frecuencia).** El bolillo o la tortilla dejan centavos por pieza, pero son la razón por la que el cliente entra a la tienda. Si solo midiéramos ganancia, se irían a B o C.
- **Pesos, no unidades.** Así un kilo de frijol a granel y una lata de atún se comparan parejo.

### ¿Cómo se corta?

Se ordena de mayor a menor puntaje y se va sumando el acumulado:

| Clase | Acumulado antes del producto |
|---|---|
| A | menos del 80 % |
| B | del 80 % al 95 % |
| C | del 95 % en adelante |

### Reglas que corrigen al Pareto

1. **Histéresis (±3 %).** Si un producto queda en la orilla entre dos clases, se queda en la que ya tenía. Así no brinca de A a B y de regreso cada semana, que confunde al tendero.
2. **Dinero dormido.** Si tiene existencia y **cero ventas** en 30 días, pasa directo a C y se marca 😴.
3. **Producto gancho.** Si el tendero dice "si se acaba, el cliente se va a otra tienda", **nunca baja de B**, aunque deje poco.
4. **Producto nuevo.** Con menos de 14 días de ventas, no se le cambia la clase. Sus ventas se escalan a 30 días solo para mostrarlas, sin meterlas en el Pareto.
5. **Pocos productos.** Si hay menos de 8 productos con ventas, el Pareto no tiene sentido y se respetan las clases actuales.

---

## 3. Modo guiado (sin historial)

Una tarjeta por producto, con dos preguntas de botón grande:

1. **¿Cada cuánto lo vendes?**
   🔥 Varias veces al día → **A** · 📅 Unas veces por semana → **B** · 💤 Casi no se vende → **C**
2. **Si se te acaba, ¿el cliente se va a otra tienda?**
   👍 Sí → se marca como gancho (nunca baja de B) · 👎 No

La primera respuesta **ya viene marcada según la categoría**: Lácteos, Huevo, Pan y Bebidas salen como "varias veces al día"; Limpieza, como "casi no". Con eso, el tendero solo confirma con un toque, en vez de pensar 300 productos desde cero.

> **Decisión de diseño.** Primero probamos convertir las respuestas en ventas estimadas y meterlas al Pareto, pero el resultado era malo. Con solo 3 opciones, todo lo que "se vende varias veces al día" queda con las mismas unidades, y el ranking termina decidiéndose por el **precio**: el Yoplait salía A y el bolillo B. Por eso en el modo guiado la respuesta decide la clase directo, y el Pareto se usa solo con ventas reales.

---

## 4. Qué cambia en el sistema según la clase

| | A | B | C |
|---|---|---|---|
| Conteo ciego desde el celular | cada 7 días | cada 15 días | cada 30 días |
| Nivel de servicio objetivo | 97 % | 90 % | 80 % |
| Alerta matutina "por agotarse" | Sí | Sí | No |
| Acceso rápido en el POS | Sí | No | No |

El nivel de servicio sirve para calcular el stock de seguridad cuando tengamos la variación de la demanda: `SS = z × σ_diaria × √(días del proveedor)`, con z ≈ 1.88 para A, 1.28 para B y 0.84 para C.

---

## 5. Cuándo se recalcula

- La sugerencia se recalcula **sola** cada vez que cambian las ventas, los candados o las respuestas (es un `computed` de Angular).
- Los cambios **no se aplican solos**. El tendero ve "⚠️ N productos deberían cambiar de clase" y los acepta uno por uno o todos juntos. Así nunca le cambia nada sin que se entere.
- Recomendado en producción: recalcular cada **lunes en la mañana** y mandar la alerta en el resumen matutino.

---

## 6. Parámetros (`DEFAULT_ABC_CONFIG`)

| Parámetro | Valor | Para qué |
|---|---|---|
| `windowDays` | 30 | Días de ventas que se analizan |
| `minDaysForAuto` | 14 | Días mínimos para pasar de guiado a automático |
| `weightProfit` | 0.7 | Peso de la ganancia (0.3 va a la frecuencia) |
| `cutA` / `cutB` | 0.80 / 0.95 | Cortes del Pareto |
| `hysteresis` | 0.03 | Tolerancia en la orilla |
| `minProductsForPareto` | 8 | Mínimo de productos con ventas |

Con el catálogo de demo (15 productos), la Clase A queda con 7 productos (47 %). En una tienda real con 300 a 800 productos, la proporción se acerca al 20/80 clásico.

---

## 7. Pendiente para producción

- Calcular `SalesStats` desde el Kardex real (ahorita se simulan con `dailySalesRate`).
- Guardar candados, respuestas guiadas y la historia de clases en la base de datos.
- Usar estacionalidad (Día de Muertos, fiestas de la vela del Istmo) cuando haya un año de datos.
- Hacer que el conteo ciego del celular use `ABC_POLICIES.countEveryDays` para armar la lista del día.
