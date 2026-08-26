# Capítulo 04 — Testing, refactor y code smells

> **Focus:** Escribir tests que aporten valor real (no frágiles ni ceremoniales), practicar TDD como disciplina de diseño, distinguir test doubles, refactorizar código legacy con red de seguridad y aplicar el catálogo de smells de Fowler.
> **Áreas:** Testing · Refactor · Code smells
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 22 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

---

## 0. Antes de empezar

**Pre-requisitos:**
- Programación OO básica (clases, interfaces, herencia) en Java, C#, TypeScript, Python o similar.
- Uso mínimo de un framework de test (JUnit 5, pytest, Jest, xUnit).
- Nociones de Git (rama, commit atómico, revert) porque el refactor seguro depende de commits pequeños y revertibles.
- Ideal: leer previamente [Cap 02 — arquitectura y DDD](./02-solid-y-patrones.md) y [Cap 03 — concurrencia y async](./03-concurrencia-y-async.md).

**Glosario mínimo:**
- **Test double**: término paraguas (Meszaros) para cualquier objeto que reemplace una dependencia real en un test. Incluye dummy, stub, fake, spy y mock.
- **Fake**: implementación funcional pero simplificada (in-memory repository, in-memory queue).
- **Stub**: retorna respuestas canned pre-programadas ante llamadas.
- **Mock**: verifica interacciones (llamadas y argumentos) con expectations pre-set.
- **AAA / Given-When-Then**: estructura de tres bloques (Arrange-Act-Assert / setup-acción-verificación).
- **Characterization test**: test que captura el comportamiento actual de código legacy sin juicio sobre si es correcto.
- **Mutation testing**: herramienta que introduce bugs deliberados (mutantes) en el código y verifica que al menos un test falla. Mide la calidad del test suite, no solo la ejecución.
- **Property-based testing**: framework que genera cientos de inputs aleatorios y verifica invariantes universales (`reverse(reverse(x)) == x`).
- **Strangler Fig**: patrón de Fowler para migrar sistemas legacy interceptando tráfico con un proxy y sustituyendo endpoints uno a uno.
- **Seam** (Feathers): punto del código donde puedes alterar el comportamiento sin modificarlo, para introducir tests.

**Setup mínimo (Java + JavaScript + Python en el mismo repo):**

```bash
# 1. Java (Maven o Gradle) — JUnit 5 + AssertJ + Mockito + Pitest
mvn archetype:generate -DgroupId=com.linguadev -DartifactId=refactor-lab \
    -DarchetypeArtifactId=maven-archetype-quickstart -DinteractiveMode=false
cd refactor-lab
# Añadir a pom.xml: junit-jupiter 5.11, assertj-core 3.26, mockito-core 5.14,
# pitest-maven 1.16 (mutation testing), testcontainers 1.20 (fakes reales)
mvn test
mvn org.pitest:pitest-maven:mutationCoverage

# 2. JavaScript / TypeScript — Jest + fast-check (property-based) + Stryker (mutation)
pnpm init
pnpm add -D jest @types/jest ts-jest typescript
pnpm add -D fast-check @stryker-mutator/core @stryker-mutator/jest-runner
pnpx jest --init
pnpx stryker init
pnpx stryker run

# 3. Python — pytest + hypothesis (property-based) + mutmut (mutation)
python -m venv .venv && source .venv/bin/activate  # (o .venv/Scripts/activate en Git Bash Windows)
pip install pytest hypothesis mutmut coverage
pytest --cov=src --cov-report=html
mutmut run && mutmut results

# 4. Verificar que TODO funciona antes de empezar los ejercicios
mvn test && pnpm test && pytest
```

Si estos cuatro comandos pasan en verde, tu ambiente está listo para el capítulo.

---

## 1. El gran cuadro

Un test suite útil cumple tres funciones simultáneas: **detecta regresiones** (falla cuando el comportamiento observable cambia sin intención), **actúa como documentación viva** (un dev nuevo lee el test y entiende cómo se usa el código) y **facilita el refactor** (te da confianza para reestructurar sin romper). Un test suite mal diseñado hace lo contrario: falla ante refactors internos sin cambios de comportamiento, es ilegible como especificación, y frena cualquier cambio porque nadie sabe qué es bug real vs test frágil. La diferencia entre ambos mundos no está en la cantidad de tests ni en el porcentaje de coverage; está en cómo se escriben y qué se verifica.

El segundo eje del capítulo es el **refactor**. Un ingeniero senior no ve el refactor como "sprint de deuda técnica" separado, sino como una actividad continua e incremental: al tocar una parte del código, la deja un poco mejor (Boy Scout Rule). El catálogo de Fowler en *Refactoring* (2ª ed., 2018) codifica cientos de transformaciones mecánicas, seguras, reversibles: Extract Method, Move Method, Replace Conditional with Polymorphism, Introduce Parameter Object. Cada una es un cambio pequeño. La combinación disciplinada de estos cambios lleva a rediseños grandes sin el riesgo del big-bang rewrite —el famoso "segundo sistema" (Brooks) que raramente termina bien (Netscape, Nokia Symbian, Windows Longhorn).

El tercer eje es la **relación bidireccional entre test y diseño**. Kent Beck propuso TDD (Test-Driven Development) no como "escribir muchos tests" sino como **herramienta de diseño**: escribir el test primero fuerza a pensar en la interfaz desde el punto de vista del consumidor. Si un test es doloroso de escribir, el diseño del código bajo test tiene problemas: acoplamiento excesivo, dependencias implícitas, responsabilidades mezcladas. Feedback rápido y honesto. Ian Cooper ("TDD, Where Did It All Go Wrong", 2017) matizó cómo el mal uso de mocks convirtió muchas prácticas de TDD en teatro de tests que verifican implementación en lugar de comportamiento —el smell moderno más común.

Finalmente, el capítulo cubre **calidad de tests**, no solo cantidad. Coverage como métrica es indicador negativo útil (0% coverage = sin tests) pero engañoso como objetivo positivo (95% coverage con tests sin asserts protege de nada). La disciplina moderna usa **mutation testing** (Pitest en Java, Stryker en JS/TS, mutmut en Python) para medir si tus tests realmente detectan bugs: se introducen mutantes (cambios pequeños al código como `>` por `>=`) y se verifica que al menos un test falla. Si el mutante sobrevive, tienes coverage sin efecto —los tests ejecutan la línea pero no verifican nada relevante. Google, LinkedIn y otras empresas grandes adoptaron mutation testing tras descubrir que 30-40% de sus tests no detectaban mutations obvias.

---

## 2. Fundamentos (nivel básico)

### 2.1 La pirámide de tests (Cohn, 2009)

Mike Cohn formalizó la **Test Pyramid** en *Succeeding with Agile*: una base ancha de **unit tests** (rápidos, aislados, muchos), una capa media de **integration tests** (algunos), y una cima estrecha de **end-to-end tests** (pocos, para paths críticos). Ratios típicos: 70/20/10 o 80/15/5.

```
        /\
       /E2E\        ← pocos (5-10%), lentos, cubren user journeys críticos
      /------\
     / integr. \    ← algunos (15-20%), verifican límites entre componentes
    /------------\
   /  unit tests  \  ← muchos (70-80%), rápidos, aíslan lógica
  /----------------\
```

**Anti-patrones de pirámide:**
- **Ice-cream cone**: muchos E2E, pocos unit. Suite lenta (horas), frágil, feedback tardío. Es el mundo real de muchos equipos legacy.
- **Hourglass**: muchos unit + muchos E2E, casi ningún integration. Bugs en las costuras entre componentes pasan desapercibidos.

**Ejemplo mínimo (Java + JUnit 5):**

```java
// Unit test: aislado, sin DB, sin red, sub-milisegundo
@Test
void calculatesTotalWithTax() {
    var pricing = new PricingService(0.21); // IVA 21%
    var total = pricing.total(new Money(100, "EUR"));
    assertThat(total).isEqualTo(new Money(121, "EUR"));
}
```

Este test corre en microsegundos, no depende de nada externo, y si falla apunta directamente al método `total()`. Es el 80% ideal de tu suite.

### 2.2 Taxonomía de test doubles (Meszaros / Fowler)

Gerard Meszaros formalizó los tipos en *xUnit Test Patterns* (2007) y Martin Fowler los popularizó en "Mocks Aren't Stubs":

| Tipo | Propósito | Verifica interacciones | Ejemplo |
|---|---|---|---|
| **Dummy** | Se pasa pero no se usa | No | `null` o `new Object()` para llenar un parámetro |
| **Stub** | Devuelve respuestas canned | No | `when(clock.now()).thenReturn(fixed)` |
| **Fake** | Implementación funcional simplificada | No | `InMemoryRepository`, `H2` en tests |
| **Spy** | Stub + graba llamadas | Sí, opcional | `Mockito.spy(realObject)` |
| **Mock** | Verifica interacciones con expectations | Sí | `verify(sender).send(user, msg)` |

**Regla profesional 2026:** para colaboradores internos (tus propias clases, tus propios repositorios), prefiere **fakes**. Para límites externos del sistema (HTTP, filesystem, tiempo, colas), acepta **mocks** o **stubs** con conservadurismo. Google publica internamente "Prefer Fakes Over Mocks" como guideline oficial en su libro *Software Engineering at Google* (Winters, Manshreck, Wright, 2020).

**Ejemplo mínimo (fake vs mock):**

```java
// FAKE: implementación real pero simplificada
public class InMemoryEmailSender implements EmailSender {
    private final List<Email> sent = new ArrayList<>();
    public void send(Email e) { sent.add(e); }
    public List<Email> sentEmails() { return sent; }
}

@Test
void sendsWelcomeEmailOnSignup() {
    var sender = new InMemoryEmailSender();
    var svc = new SignupService(sender);
    svc.signup("alice@example.com");
    // Verifica EFECTO observable, no llamada específica
    assertThat(sender.sentEmails())
        .anyMatch(e -> e.to().equals("alice@example.com") && e.subject().contains("Welcome"));
}

// MOCK: verifica CÓMO se llamó al colaborador. Frágil ante refactor.
@Test
void mocked_sendsWelcomeEmailOnSignup_FRAGIL() {
    var sender = mock(EmailSender.class);
    var svc = new SignupService(sender);
    svc.signup("alice@example.com");
    // Si el servicio internamente cambia el orden o divide en dos llamadas,
    // este test rompe aunque el efecto observable sea idéntico.
    verify(sender).send(argThat(e -> e.subject().equals("Welcome to LinguaDev")));
}
```

El primer test sigue verde tras cualquier refactor interno mientras el efecto sea el mismo email al mismo destinatario. El segundo rompe si cambia el subject exacto —incluso si es una mejora del texto.

### 2.3 AAA / Given-When-Then

Todo test unitario legible sigue tres bloques claros:

1. **Arrange (Given)**: preparar el contexto y las dependencias.
2. **Act (When)**: ejecutar UNA acción bajo test.
3. **Assert (Then)**: verificar el resultado esperado.

```python
# pytest — AAA explícito con comentarios (opcionales pero útiles al aprender)
def test_discount_applies_for_loyal_customer():
    # Arrange
    customer = CustomerBuilder().with_loyalty_level(3).build()
    order = OrderBuilder().with_items([Item("book", 10)]).build()
    calc = PriceCalculator(discount_policy=LoyaltyDiscount())

    # Act
    total = calc.total_for(customer, order)

    # Assert
    assert total == Money(9.00, "EUR")  # 10% descuento por loyalty >= 3
```

**Nombre del test**: `test_discount_applies_for_loyal_customer` documenta el comportamiento esperado sin leer el cuerpo. Convenciones populares: `should_returnX_when_Y`, `methodName_scenario_expectedResult`.

### 2.4 Los code smells que verás cada semana

Fowler cataloga docenas de smells en *Refactoring* Cap. 3. Los cinco más frecuentes en la práctica:

- **Long Method**: >50 líneas, múltiples responsabilidades mezcladas. Fix: Extract Method.
- **Primitive Obsession**: strings/ints/doubles para conceptos ricos del dominio (email, dinero, id). Fix: Value Object (records en Java 21+, data class en Kotlin, branded types en TypeScript).
- **Feature Envy**: método que accede más a datos de OTRA clase que a los suyos propios. Fix: Move Method a la clase envidiada.
- **Long Parameter List**: >4-5 parámetros. Fix: Introduce Parameter Object.
- **Data Clumps**: mismos 3-4 parámetros aparecen juntos siempre. Fix: extraer clase que los agrupa.

### 2.5 La Rule of Three

Fowler y Beck: **duplica una vez, extrae en la tercera**. Con 1 caso no sabes si es patrón o singularidad; con 2 puede ser coincidencia; con 3 es un patrón real que vale la pena abstraer. Sandi Metz ("The Wrong Abstraction", 2016) añade: "duplication is far cheaper than the wrong abstraction". DRY prematuro te ata a una abstracción que no encaja cuando llega el segundo o tercer caso.

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 Anatomía de un test frágil vs uno robusto

Kent Beck y Michael Feathers formularon la regla más importante del testing:

> "Un test debe ser **resistente al refactor** y **sensible al cambio de comportamiento**."

Un mock sobre-específico rompe esta regla —es sensible al refactor. Ejemplo de test frágil:

```java
// FRÁGIL: verifica orden, argumentos exactos, número de llamadas.
// Cualquier refactor interno lo rompe.
@Test
void createInvoice_FRAGIL() {
    var svc = new InvoiceService(pdfRenderer, emailSender, db, auditLog);
    svc.createInvoice(user);

    verify(pdfRenderer).render(argThat(i -> i.getTotal() == 100));
    verify(emailSender).send(eq(user), argThat(s -> s.contains("$100")));
    verify(db).save(any(Invoice.class));
    verify(auditLog).write(argThat(l -> l.startsWith("INVOICE:")));
    verifyNoMoreInteractions(pdfRenderer, emailSender, db, auditLog);
}
```

Si el servicio cambia el prefijo del audit log de `INVOICE:` a `INV:`, o divide el email en dos partes (subject + body), o el PDF pasa por un template intermedio, todos rompen. Sin cambio observable, 20 tests como este colapsan.

Versión robusta con **fakes** que capturan el efecto:

```java
@Test
void createInvoice_ROBUSTO() {
    var db = new InMemoryInvoiceRepository();
    var sender = new InMemoryEmailSender();
    var audit = new InMemoryAuditLog();
    var pdfs = new InMemoryPdfStore();
    var svc = new InvoiceService(pdfs, sender, db, audit);

    var invoiceId = svc.createInvoice(user);

    // Verifica RESULTADO observable, no CÓMO se llegó a él
    Invoice saved = db.findById(invoiceId).orElseThrow();
    assertThat(saved.total()).isEqualTo(Money.of(100, "EUR"));
    assertThat(sender.sentEmails()).anyMatch(e -> e.to().equals(user.email()));
    assertThat(pdfs.storedPdfs()).hasSize(1);
    assertThat(audit.entries()).anyMatch(e -> e.action().equals("INVOICE_CREATED"));
}
```

Este test sobrevive a cualquier refactor interno mientras el efecto siga siendo: se guarda una invoice de 100 EUR, se envía email al usuario, se genera 1 PDF, se audita la acción. Es lo que realmente importa a negocio.

### 3.2 Coverage y su ilusión

`JaCoCo`, `coverage.py` o `nyc` miden **ejecución** de líneas/branches, no **verificación**. Un test que ejecuta todo el código sin asserts significativos da 100% coverage y 0% protección.

**Mutation testing** cambia el juego: introduce mutaciones sistemáticas (Pitest genera >30 tipos: `>` → `>=`, `+` → `-`, `return x` → `return null`, remover llamadas de void), y ejecuta la suite. Si ningún test detecta la mutación (**mutante sobrevive**), tienes tests que no verifican esa lógica.

**Métricas comparadas en el mismo módulo:**

| Métrica | Valor | Interpretación |
|---|---|---|
| Line coverage | 95% | Se ejecuta casi todo |
| Branch coverage | 88% | La mayoría de if/else se visitan |
| **Mutation score** | 42% | 58% de mutantes NO detectados: **muchos tests no verifican nada útil** |

Ejemplo Pitest en Maven:

```bash
mvn org.pitest:pitest-maven:mutationCoverage
# Genera target/pit-reports/ con HTML detallado:
# - qué líneas tienen mutantes vivos
# - qué mutaciones específicas sobreviven
# - cuál mutation operator fue usado
```

**Regla mental 2026**: coverage ≥ 80% es requisito de higiene; mutation score ≥ 70% en módulos críticos es el auténtico "well-tested".

### 3.3 Diagrama de flujo — decidir tipo de test

```
                    ¿Qué estoy testeando?
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   Lógica pura        Interacción entre        Flujo completo
   (algoritmo,        componentes de           user-facing
   validación,         mi sistema             (login → dashboard)
   cálculo)                   │                     │
        │              ┌──────┴──────┐              │
        │              │             │              │
        │        Con DB/queue    Sin infra          │
        │        externa (HTTP)  externa            │
        │              │             │              │
    Unit test    Integration    Component/         E2E test
   (in-memory,   con             Contract test    (Playwright,
    <10 ms)      Testcontainers  (Pact)           Cypress)
                 (real Postgres
                  en Docker)
```

### 3.4 Test smells frecuentes

| Smell | Ejemplo | Fix |
|---|---|---|
| **Mystery Guest** | Test lee un CSV mágico de disco | Fixtures inline con Test Data Builder |
| **Eager Test** | Un test verifica 5 comportamientos | Split en 5 tests con nombres claros |
| **Fragile Test** | Rompe con cualquier refactor interno | Cambiar mocks por fakes; verificar comportamiento, no implementación |
| **Slow Test** | Suite >5 min | Mover E2E a nightly, mantener unit <1 min |
| **Erratic Test** (flaky) | Falla 1 de cada N runs | Diagnosticar causa raíz; nunca `@Retry` como fix |
| **Test Interdependence** | Falla si cambia el orden | Aislamiento total: setup/teardown por test |
| **Assertion Roulette** | Muchos asserts sin mensaje | Split o AssertJ SoftAssertions con contexto |
| **Comment Test** | Test comentado con `// TODO fix` | Bórralo o arréglalo; código muerto miente |

---

## 4. Práctica avanzada (nivel senior/staff)

### 4.1 TDD real: Red → Green → Refactor

El ciclo canónico (Kent Beck, *TDD by Example*, 2002):

1. **Red**: escribes el test más pequeño que falle expresando lo que quieres.
2. **Green**: escribes el código MÍNIMO —feo si hace falta— que lo haga pasar.
3. **Refactor**: mejoras el código manteniendo los tests verdes.

Ciclos cortos (segundos-minutos). El poder de TDD **no** está en escribir tests, sino en:
- **Diseñar la API desde el consumo** (si es doloroso testear, es doloroso usar).
- **Garantizar que el test detecta la ausencia del código** (si nunca vio rojo, ¿cómo sabes que detectaría el bug?).
- **Refactor con red de seguridad continua**.

**Anti-patrón común**: escribir la clase completa, luego escribir tests que pasen. No es TDD, es Test-After. Los tests están acoplados a la implementación que ya existe; no guiaron ningún diseño.

**Cuándo TDD encaja bien**: features nuevas con requisitos claros, algoritmos, parsers, transformaciones de datos. **Cuándo cuesta más**: spikes exploratorios, UI difícil de aislar, integraciones complejas. La respuesta moderna (Cooper, Beck, incluso Uncle Bob más recientemente): TDD como herramienta, no como dogma; combinar con exploratory testing y integration tests donde aporte más.

### 4.2 Refactor de código legacy sin tests (Feathers)

Michael Feathers define legacy code como **"código sin tests"**. Sin red de seguridad, cada cambio es apostar. Su método en *Working Effectively with Legacy Code* (2004):

1. **Characterization tests primero**: llama al método con inputs típicos, captura outputs REALES (no los "deseados") como snapshots. Ahora sabes qué HACE, aunque no sepas qué DEBERÍA hacer.
2. **Identifica seams**: puntos donde puedes alterar el comportamiento sin modificar el código (subclassing, dependency injection, interfaces).
3. **Refactor pequeño** con seam identificado, tests siguen verdes.
4. **Cuando cambies comportamiento deliberadamente**, actualiza el characterization test correspondiente y documenta el porqué.

**Herramientas**: Approvaltests (Java), Verify (.NET), snapshottest (Python), Jest snapshots. Todas hacen lo mismo: guardan el output y fallan si cambia.

Ejemplo con Approvaltests:

```java
@Test
void characterizeCommissionCalculator() {
    var calc = new LegacyCommissionCalculator();
    var scenarios = List.of(
        new Scenario("junior", 30_000, 5, "US"),
        new Scenario("senior", 80_000, 15, "EU"),
        new Scenario("staff", 150_000, 20, "APAC"),
        new Scenario("edge case zero", 0, 0, "")
    );
    var results = scenarios.stream()
        .map(s -> s + " → " + calc.calculate(s))
        .collect(Collectors.joining("\n"));
    Approvals.verify(results); // Compara con .approved.txt
}
```

La primera ejecución genera `Characterize.received.txt`, tú lo revisas y renombras a `.approved.txt`. Cualquier cambio futuro debe ser aprobado explícitamente.

### 4.3 Strangler Fig Pattern para migraciones grandes

Fowler acuñó el término (2004) inspirado en la higuera estranguladora que crece sobre árboles viejos hasta reemplazarlos. Aplicación: migrar un monolito legacy sin big-bang.

**Pasos:**
1. Poner un **proxy** o **API gateway** delante del monolito (nginx, Kong, AWS API Gateway).
2. Implementar nuevo endpoint en microservicio nuevo (stack moderno).
3. Redirigir tráfico de ese endpoint del monolito al nuevo (feature flag).
4. Verificar métricas y errores.
5. Cuando el endpoint viejo no recibe tráfico, borrarlo del monolito.
6. Repetir por cada endpoint.

**Ventajas vs big-bang rewrite:**
- Riesgo mínimo (un endpoint a la vez, revertible en segundos).
- Valor entregado desde día 1.
- Los tests emergen naturalmente.
- El equipo aprende el dominio durante la migración.

Amazon, Netflix, Shopify migraron sus monolitos con esta estrategia durante 5-10 años. El intento contrario —Netscape reescribiendo el navegador en 2001— es el caso de estudio canónico del fracaso ("Things You Should Never Do, Part I", Joel Spolsky).

### 4.4 Contract testing con Pact

En arquitecturas de microservicios, los tests unitarios y de integración por servicio no detectan cuando el provider (PaymentService) cambia su API y rompe al consumer (OrderService).

**Consumer-Driven Contracts (Ian Robinson, 2006)**:
1. El consumer escribe test declarando qué espera del provider (`POST /pay con {amount} responde {id, status}`).
2. Pact genera un **contract file** (JSON) en base a esos tests.
3. El provider ejecuta el contract file contra su implementación en su CI.
4. Si el provider cambia y rompe el contract, falla ANTES de deploy.

Ventajas frente a E2E:
- Rápido: no arranca servicios completos.
- Aislado: cada servicio se testea contra el contract, no contra el sistema entero.
- El contract sirve de documentación viva.

Ejemplo Pact en JS (consumer side):

```js
// order-service.consumer.test.js
const { Pact } = require('@pact-foundation/pact');
const provider = new Pact({ consumer: 'OrderService', provider: 'PaymentService' });

test('paymentService charges card and returns transaction id', async () => {
    await provider.setup();
    await provider.addInteraction({
        state: 'valid card and funds available',
        uponReceiving: 'a request to charge $10',
        withRequest: { method: 'POST', path: '/pay', body: { amount: 10, currency: 'EUR' } },
        willRespondWith: { status: 200, body: { id: like('tx_123'), status: 'success' } }
    });
    const result = await charge({ amount: 10, currency: 'EUR' });
    expect(result.status).toBe('success');
    await provider.verify();
});
```

### 4.5 Property-based testing

Cambio de paradigma sobre el ejemplo-based testing tradicional. En lugar de casos concretos, declaras **propiedades universales** que deben cumplirse SIEMPRE, y el framework genera cientos de inputs aleatorios para intentar romperlas.

```python
# hypothesis (Python)
from hypothesis import given, strategies as st

@given(st.lists(st.integers()))
def test_reverse_is_involutive(xs):
    assert list(reversed(list(reversed(xs)))) == xs

@given(st.lists(st.integers()))
def test_sort_is_idempotent(xs):
    assert sorted(sorted(xs)) == sorted(xs)

@given(st.integers(min_value=0), st.integers(min_value=0))
def test_addition_commutative(a, b):
    assert a + b == b + a
```

Hypothesis prueba 100+ inputs por default, incluyendo edge cases que raramente pensarías (listas vacías, un elemento, listas gigantes, negativos, `-2**31`, unicode). Cuando encuentra un fallo, hace **shrinking**: reduce el input al mínimo que reproduce el bug ("la lista más corta que hace fallar").

Casos ideales: parsers, serializers, algoritmos, compresores, criptografía, validators. AWS lo usó extensivamente al reescribir ChunkedEncoding de S3.

### 4.6 Anti-patrones catalogados

| Anti-patrón | Por qué es malo | Fix |
|---|---|---|
| **Mock everything** | Tests verifican implementación, frágil ante refactor | Fakes para colaboradores internos; mocks solo para bordes externos |
| **Coverage-driven testing** | Tests para pasar la métrica, no para prevenir bugs | Mutation testing como validador de calidad |
| **@Retry(3) en flaky test** | Esconde el bug, permite acumulación | Diagnosticar causa raíz; quarantine hasta arreglar |
| **God Test** | 1 test verifica 5 comportamientos | Split en múltiples tests atómicos |
| **Test-after llamado TDD** | Sin ciclo rojo→verde, no valida que detecta ausencia | Escribir test primero de verdad |
| **Snapshot approval automático** | Devs aprueban sin leer, valor cae a cero | Revisar cada snapshot change en code review |
| **Setup verboso repetido** | Cambio en modelo rompe 40 tests | Test Data Builder / Object Mother |
| **Sleep(100) en async** | Frágil ante variabilidad de CI | Awaitility / waitFor con condición real |

---

## 5. Ejemplo práctico completo: refactor de un `PricingService` legacy

Vas a tomar un método legacy de 80 líneas con múltiples smells (Long Method, Primitive Obsession, Feature Envy) y refactorizarlo aplicando TDD con red de seguridad.

### 5.1 Punto de partida — código legacy sin tests

```java
// src/main/java/com/linguadev/pricing/LegacyPricingService.java
public class LegacyPricingService {

    public double calculateFinalPrice(String productType, double basePrice,
                                       String currency, int loyaltyLevel,
                                       String country, boolean hasCoupon,
                                       double couponValue, String couponType) {
        double price = basePrice;

        // Aplicar tipo de producto
        if (productType.equals("digital")) {
            price = price * 1.0;
        } else if (productType.equals("physical")) {
            price = price + 5.0; // shipping
        } else if (productType.equals("subscription")) {
            price = price * 0.9; // 10% descuento por suscripción
        }

        // Descuento loyalty
        if (loyaltyLevel >= 3 && loyaltyLevel < 5) {
            price = price * 0.95;
        } else if (loyaltyLevel >= 5) {
            price = price * 0.90;
        }

        // IVA por país
        if (country.equals("ES")) {
            price = price * 1.21;
        } else if (country.equals("DE")) {
            price = price * 1.19;
        } else if (country.equals("US")) {
            price = price * 1.0;
        }

        // Cupón
        if (hasCoupon) {
            if (couponType.equals("percent")) {
                price = price * (1.0 - couponValue / 100.0);
            } else if (couponType.equals("fixed")) {
                price = price - couponValue;
            }
        }

        if (price < 0) price = 0;
        return price;
    }
}
```

**Smells detectados:**
- Long Method (~40 líneas de lógica anidada).
- Primitive Obsession (`String productType`, `String currency`, `double price`).
- Feature Envy (la lógica de descuento pertenece a customer; IVA a country).
- Long Parameter List (8 parámetros).
- Magic Numbers (0.9, 0.95, 5.0, 1.21).

### 5.2 Paso 1 — Characterization tests (red de seguridad)

```java
// src/test/java/com/linguadev/pricing/LegacyPricingServiceCharacterizationTest.java
class LegacyPricingServiceCharacterizationTest {
    private final LegacyPricingService svc = new LegacyPricingService();

    @Test
    void digitalProductInSpainWithLoyalty5AndPercentCoupon() {
        double result = svc.calculateFinalPrice(
            "digital", 100.0, "EUR", 5, "ES", true, 10.0, "percent");
        // Verificamos el output ACTUAL, sin juicio de si es correcto.
        // 100 (digital *1) * 0.90 (loyalty) * 1.21 (IVA ES) * 0.90 (coupon 10%) = 98.01
        assertThat(result).isCloseTo(98.01, within(0.01));
    }

    @Test
    void physicalProductInGermanyWithoutCoupon() {
        double result = svc.calculateFinalPrice(
            "physical", 50.0, "EUR", 1, "DE", false, 0.0, "");
        // (50 + 5 shipping) * 1.19 IVA = 65.45
        assertThat(result).isCloseTo(65.45, within(0.01));
    }

    @Test
    void subscriptionUSWithFixedCoupon() {
        double result = svc.calculateFinalPrice(
            "subscription", 20.0, "USD", 0, "US", true, 5.0, "fixed");
        // 20 * 0.9 sub - 5 = 13.00
        assertThat(result).isCloseTo(13.00, within(0.01));
    }

    @Test
    void negativePriceIsClampedToZero() {
        double result = svc.calculateFinalPrice(
            "digital", 10.0, "EUR", 0, "US", true, 100.0, "fixed");
        assertThat(result).isEqualTo(0.0);
    }
}
```

Ahora tienes red de seguridad. Cualquier refactor debe mantener estos tests verdes.

### 5.3 Paso 2 — Introducir Value Objects (Primitive Obsession)

```java
// Value Objects
public record Money(BigDecimal amount, Currency currency) {
    public static Money of(double amount, String currency) {
        return new Money(BigDecimal.valueOf(amount), Currency.getInstance(currency));
    }
    public Money multiply(BigDecimal factor) { return new Money(amount.multiply(factor), currency); }
    public Money add(Money other) { requireSameCurrency(other); return new Money(amount.add(other.amount), currency); }
    public Money subtract(Money other) { requireSameCurrency(other); return new Money(amount.subtract(other.amount), currency); }
    public Money max(Money other) { return amount.compareTo(other.amount) >= 0 ? this : other; }
    private void requireSameCurrency(Money o) {
        if (!currency.equals(o.currency)) throw new IllegalArgumentException("Currency mismatch");
    }
}

public enum ProductType { DIGITAL, PHYSICAL, SUBSCRIPTION }
public enum Country { ES, DE, US, FR, IT }
public record LoyaltyLevel(int value) {
    public LoyaltyLevel { if (value < 0) throw new IllegalArgumentException(); }
}
public sealed interface Coupon permits Coupon.Percent, Coupon.Fixed, Coupon.None {
    record Percent(BigDecimal rate) implements Coupon {}
    record Fixed(Money amount) implements Coupon {}
    record None() implements Coupon {}
}
```

### 5.4 Paso 3 — Extract Method + Extract Class

```java
public class PricingService {
    private final ProductPricingRule productPricing;
    private final LoyaltyDiscountRule loyaltyDiscount;
    private final CountryTaxRule countryTax;
    private final CouponRule couponRule;

    public PricingService(ProductPricingRule pp, LoyaltyDiscountRule ld,
                          CountryTaxRule ct, CouponRule cr) {
        this.productPricing = pp;
        this.loyaltyDiscount = ld;
        this.countryTax = ct;
        this.couponRule = cr;
    }

    public Money calculateFinalPrice(PricingRequest req) {
        var base = productPricing.apply(req.basePrice(), req.productType());
        var afterLoyalty = loyaltyDiscount.apply(base, req.loyaltyLevel());
        var afterTax = countryTax.apply(afterLoyalty, req.country());
        var afterCoupon = couponRule.apply(afterTax, req.coupon());
        return afterCoupon.max(Money.of(0, req.basePrice().currency().getCurrencyCode()));
    }
}

public record PricingRequest(Money basePrice, ProductType productType,
                             LoyaltyLevel loyaltyLevel, Country country, Coupon coupon) {}
```

Cada regla vive en su clase con su test unitario aislado:

```java
public class LoyaltyDiscountRule {
    public Money apply(Money price, LoyaltyLevel level) {
        BigDecimal factor = switch (level.value()) {
            case 0, 1, 2 -> BigDecimal.ONE;
            case 3, 4 -> new BigDecimal("0.95");
            default -> new BigDecimal("0.90");
        };
        return price.multiply(factor);
    }
}

@Test
void loyalty_level5_applies_10_percent_discount() {
    var rule = new LoyaltyDiscountRule();
    var result = rule.apply(Money.of(100, "EUR"), new LoyaltyLevel(5));
    assertThat(result).isEqualTo(Money.of(90.00, "EUR"));
}
```

### 5.5 Paso 4 — Adaptador para characterization tests

Para que los tests originales sigan verdes durante la migración, mantén un adaptador:

```java
@Deprecated
public class LegacyPricingService {
    private final PricingService modern = PricingServiceFactory.create();

    public double calculateFinalPrice(String productType, double basePrice, String currency,
                                       int loyaltyLevel, String country, boolean hasCoupon,
                                       double couponValue, String couponType) {
        var req = new PricingRequest(
            Money.of(basePrice, currency),
            ProductType.valueOf(productType.toUpperCase()),
            new LoyaltyLevel(loyaltyLevel),
            Country.valueOf(country),
            buildCoupon(hasCoupon, couponValue, couponType, currency)
        );
        return modern.calculateFinalPrice(req).amount().doubleValue();
    }
    private Coupon buildCoupon(boolean has, double value, String type, String currency) {
        if (!has) return new Coupon.None();
        return switch (type) {
            case "percent" -> new Coupon.Percent(BigDecimal.valueOf(value / 100.0));
            case "fixed" -> new Coupon.Fixed(Money.of(value, currency));
            default -> new Coupon.None();
        };
    }
}
```

Los characterization tests siguen verdes, los clientes viejos siguen funcionando, y el nuevo código tiene tests unitarios granulares por regla.

### 5.6 Paso 5 — Mutation testing para validar

```bash
mvn org.pitest:pitest-maven:mutationCoverage
# Objetivo: >85% mutation score en las reglas nuevas
# Si un mutante sobrevive (ej. cambia 0.95 por 0.99 y ningún test falla),
# añade un test específico para ese valor.
```

Total: pasaste de 80 líneas ilegibles sin tests a 5 clases pequeñas con tests unitarios granulares, characterization tests preservados, y mutation score >85%. El diseño ahora acepta nuevas reglas (Black Friday, códigos promocionales por país) sin tocar la lógica existente.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### 6.1 Reglas mentales del testing profesional

- **Un test debe ser resistente al refactor y sensible al cambio de comportamiento** (Beck/Feathers).
- **Prefiere fakes sobre mocks** para colaboradores internos (Google).
- **Coverage es indicador negativo, no positivo**; mutation score es la métrica de calidad.
- **Si un test es difícil de escribir, el diseño del código bajo test es sospechoso**.
- **Boy Scout Rule**: deja el código un poco mejor de lo que lo encontraste.
- **Rule of Three**: duplica una vez, extrae en la tercera.
- **Duplication is far cheaper than the wrong abstraction** (Metz).
- **Legacy code = código sin tests** (Feathers). Añade characterization tests antes de refactorizar.
- **No hay `@Retry` que arregle un flaky test**; diagnostica la causa raíz.
- **Los mocks son adecuados para bordes externos** (HTTP, tiempo, filesystem); dentro del sistema usa fakes.

### 6.2 Tabla de decisión: ¿qué doble usar?

| Escenario | Doble recomendado | Ejemplo |
|---|---|---|
| Repositorio propio (Usuario, Order) | **Fake in-memory** | `InMemoryUserRepository` |
| Cliente HTTP externo | **Stub** o **WireMock** | Devuelve JSON canned |
| Reloj / tiempo | **Stub** con `Clock.fixed()` | Testear TTL sin esperar |
| Sistema de archivos | **Fake in-memory** | Jimfs (Google) |
| Base de datos real (integration) | **Fake real** con **Testcontainers** | Postgres en Docker efímero |
| Kafka | **Fake real** con **Testcontainers** | Kafka broker en Docker |
| Cola interna | **Fake in-memory** | `InMemoryEventBus` |
| Verificar que se envió un email | **Fake que graba** | `InMemoryEmailSender` con `.sentEmails()` |
| Verificar orden preciso de llamadas | **Spy** o **Mock** con `InOrder` | Solo si el orden es requisito semántico |

### 6.3 ✅ Buenas prácticas — refactor seguro

- ✅ Commits pequeños y frecuentes (cada refactor un commit revertible).
- ✅ Tests verdes en cada paso.
- ✅ Characterization tests antes de tocar legacy.
- ✅ Extract Method antes de Extract Class antes de Extract Package.
- ✅ Usar `Move Method` refactoring del IDE (IntelliJ, VSCode) — automatiza actualización de referencias.
- ✅ Renombrar con "Rename Symbol" del IDE, no con buscar-y-reemplazar.
- ✅ Value Objects sobre primitivos para conceptos ricos del dominio.
- ✅ Fluent Assertions (AssertJ, Chai) para mensajes de error legibles.

### 6.4 ❌ Anti-patrones

- ❌ Big-bang rewrite de módulos legacy sin plan de reversibilidad.
- ❌ Escribir tests después con la única meta de subir coverage.
- ❌ Mockear tu propio código sin razón (`mock(MyOwnService.class)`).
- ❌ Tests con `Thread.sleep()` para esperar operaciones async.
- ❌ Un test verificando 5 comportamientos distintos.
- ❌ `@Ignore` o `@Disabled` sin fecha de reactivación ni issue tracker.
- ❌ Snapshots aprobados sin revisar diff.
- ❌ Depender del orden de ejecución entre tests.
- ❌ Comentarios "TODO: fix this test" durante meses.

---

## 7. Casos reales de la industria (2024-2026)

- **Google, Software Engineering at Google (2020, actualizado 2024)** publicó su guideline "Prefer Fakes Over Mocks" para reducir tests frágiles. Su motor de mutation testing interno se aplica a millones de tests diarios y elimina automáticamente tests que no detectan mutants (percibidos como "coverage teatro").

- **Netflix (2020-2023)** documentó su migración de Hystrix (deprecated) a Resilience4j y su suite de chaos engineering. Cada release pasa por Chaos Monkey en staging que mata instancias aleatoriamente antes de ir a producción. Resultado: MTTR (mean time to recovery) bajó ~40% respecto a 2018.

- **AWS S3 (2020, publicado en QCon 2021)** reescribió ChunkedEncoding con property-based testing en Haskell/Rust. Descubrieron bugs latentes en la implementación C++ original que habían estado presentes durante años, pero que ningún test de ejemplos había disparado.

- **Shopify (2019-2026)** continúa aplicando Strangler Fig sobre su monolito Rails legendario (>2M líneas). Cada trimestre publican estadísticas de módulos migrados a microservicios Go/Ruby. Su equipo de Engineering Excellence tiene métricas públicas de deuda técnica por área.

- **Stripe (2023-2025)** publicó "Testing Payments at Stripe" describiendo cómo usan property-based testing (fast-check) para verificar invariantes de idempotency y consistencia eventual entre servicios distribuidos. Su webhook system procesa miles de millones de eventos con at-least-once + idempotency por design.

- **Bloomberg Terminal (2024)** anunció migración de 1M+ líneas de C++ a Rust usando Strangler Fig a nivel de módulos individuales, con característica: cada módulo Rust se ejerce en producción a través de un shim FFI y el módulo C++ queda vigente como fallback hasta validar equivalencia con 6 meses de tráfico real.

- **xz-utils backdoor (marzo 2024)** —caso de supply chain— reforzó la importancia de tests de comportamiento observables: el backdoor era invisible a los tests unitarios existentes porque explotaba side-effects del linker durante el build. Post-mortem generó nueva ola de adopción de mutation testing y reproducible builds en librerías críticas open source.

---

## 8. Ejercicios prácticos

### Ejercicio 1 — De legacy a Value Objects (30-45 min)

**Objetivo**: Refactorizar un método con Primitive Obsession usando characterization tests.

**Setup**:
```bash
mkdir -p refactor-lab/src/{main,test}/java/com/linguadev/pricing
cd refactor-lab
# Copia el LegacyPricingService del §5.1 a src/main/java/com/linguadev/pricing/
```

**Pasos**:
1. Escribe 6+ characterization tests cubriendo casos típicos y edge cases (precio negativo, cupón mayor que precio, sin cupón, país no soportado).
2. Ejecuta `mvn test` — todos deben pasar en verde.
3. Introduce el Value Object `Money` con `amount: BigDecimal + currency: Currency`.
4. Refactoriza `LegacyPricingService.calculateFinalPrice` para usar `Money` internamente, manteniendo la signature pública original.
5. Ejecuta los characterization tests — deben seguir verdes.
6. Añade un nuevo test unitario que verifique que dos requests con distinta currency lanzan `IllegalArgumentException`.

**Criterios de aceptación**:
- [ ] 6+ characterization tests verdes.
- [ ] `Money` con `add`, `subtract`, `multiply`, `max`.
- [ ] Currency mismatch lanza excepción con mensaje claro.
- [ ] `mvn test` totalmente en verde.
- [ ] Cero cambios en la signature pública de `calculateFinalPrice`.

**Bonus**: Ejecuta `mvn pitest:mutationCoverage` sobre el paquete `pricing` y logra mutation score ≥ 80%.

---

### Ejercicio 2 — TDD real: `PasswordStrengthChecker` (25-40 min)

**Objetivo**: Implementar en TDD estricto (Red → Green → Refactor) un validador de fortaleza de contraseña.

**Requisitos (para descubrir en tests, no implementar antes)**:
- Debe devolver `WEAK`, `MEDIUM`, `STRONG`, `VERY_STRONG`.
- Reglas: longitud, mayúsculas, minúsculas, dígitos, símbolos, ausencia de patrones comunes ("123", "password").

**Pasos**:
1. Escribe el primer test que falle: `emptyPassword_isWeak`.
2. Implementa el código MÍNIMO para que pase: `return WEAK;`.
3. Escribe el segundo test que fuerce nueva lógica: `password8CharsLettersOnly_isMedium`.
4. Añade solo la lógica necesaria. Refactor si emerge duplicación.
5. Continúa el ciclo hasta cubrir: dígitos, mayús+minús+dígitos, símbolos, longitud >12, patrones comunes.
6. En cada Refactor, ejecuta todos los tests para verificar red de seguridad.

**Criterios de aceptación**:
- [ ] Cada test se escribió ANTES del código que lo hace pasar.
- [ ] Al menos 8 tests que cubren cada regla independiente.
- [ ] Código final legible sin ninguna cascada de if/else >5 niveles.
- [ ] Cada commit representa un ciclo Red→Green→Refactor.

**Bonus**: Añade property-based tests con fast-check/hypothesis que verifiquen invariantes (`STRONG passwords son siempre ≥ 8 chars`).

---

### Ejercicio 3 — Detectar y eliminar tests frágiles (20-30 min)

**Objetivo**: Identificar mocks sobre-específicos y reemplazarlos con fakes.

**Setup**: Descarga un mini-proyecto (o crea uno) con estas dos clases:

```java
public class SignupService {
    private final EmailSender sender;
    private final UserRepository repo;
    private final AuditLog audit;
    // signup(email) → guarda user, envía welcome, audita
}
```

Y este test frágil:

```java
@Test
void signup_FRAGIL() {
    var svc = new SignupService(sender, repo, audit);
    svc.signup("a@b.com");
    verify(repo).save(argThat(u -> u.email().equals("a@b.com")));
    verify(sender).send(any(User.class), eq("Welcome to LinguaDev"));
    verify(audit).write(eq("SIGNUP:a@b.com"));
    verifyNoMoreInteractions(repo, sender, audit);
}
```

**Pasos**:
1. Escribe `InMemoryUserRepository`, `InMemoryEmailSender`, `InMemoryAuditLog`.
2. Reescribe el test usando los fakes, verificando **efectos observables**, no llamadas.
3. Renombra `SignupService.audit()` y cambia el prefijo del audit de `SIGNUP:` a `USER_CREATED:`. Verifica que:
   - El test frágil original **rompe** (mostrando su fragilidad).
   - El test refactorizado con fakes **sigue verde** si actualizas solo la assertion relevante del audit.

**Criterios de aceptación**:
- [ ] Los 3 fakes implementados con listas internas y accessors.
- [ ] Test refactorizado verifica: 1 usuario guardado, 1 email al destinatario correcto, 1 entrada de audit.
- [ ] Ningún `verify()` en el test refactorizado.
- [ ] Al cambiar el prefijo de audit, el test frágil rompe y el refactorizado no.

**Bonus**: Añade un segundo test que verifica idempotencia: `signup` con el mismo email dos veces solo crea un usuario.

---

### Ejercicio 4 — Mutation testing en un módulo real (30-40 min)

**Objetivo**: Descubrir gaps ocultos en un test suite aparentemente completo.

**Setup**:
```bash
# Crea o clona un módulo pequeño (p.ej. una calculadora de comisiones con 10-15 tests unitarios).
mvn org.pitest:pitest-maven:mutationCoverage
```

**Pasos**:
1. Ejecuta Pitest y abre `target/pit-reports/index.html`.
2. Identifica al menos 3 mutantes sobrevivientes.
3. Para cada uno, entiende qué mutación ocurrió (`>` → `>=`, `+` → `-`, etc.) y por qué ningún test la detectó.
4. Escribe tests específicos que "maten" cada mutante.
5. Re-ejecuta Pitest. Mutation score debería subir ≥5 puntos porcentuales.

**Criterios de aceptación**:
- [ ] Reporte HTML de Pitest generado.
- [ ] 3+ mutantes muertos con tests explícitos y documentados (comentario `// Mata mutante: > → >=`).
- [ ] Mutation score final documentado en un `TESTING.md` del proyecto.

**Bonus**: Configura Pitest para fallar el build si mutation score < 75% (`<mutationThreshold>75</mutationThreshold>` en el plugin).

---

### Ejercicio 5 — Strangler Fig sobre un endpoint (45-60 min)

**Objetivo**: Simular migración de un endpoint de un "monolito" a un "microservicio nuevo" con feature flag.

**Setup**: Un servicio Express/Fastify con endpoint `/api/pricing` que llama al `LegacyPricingService`.

**Pasos**:
1. Extrae el cálculo a un módulo aparte (`new-pricing-service`) con la interfaz refactorizada del §5.
2. Añade un feature flag: `PRICING_ENGINE=legacy|new` (env var o LaunchDarkly).
3. En el endpoint, según el flag, delega a uno u otro.
4. Añade contract tests con Pact que verifiquen que ambos endpoints devuelven exactamente el mismo output para los casos del §5.2.
5. Simula tráfico gradual: 0% → 10% → 50% → 100% con canary release.
6. Documenta el runbook de rollback (cómo poner el flag a `legacy` en <1 min).

**Criterios de aceptación**:
- [ ] Feature flag funcional documentado en README.
- [ ] Contract tests Pact que ambos backends satisfacen.
- [ ] Runbook de rollback con comandos concretos.
- [ ] Log estructurado con `engine=legacy|new` para monitoring.

**Bonus**: Añade una comparación paralela en producción (shadow mode): el nuevo servicio ejecuta el cálculo pero no devuelve el resultado al cliente; se compara con el legacy y se registra el diff.

---

## 9. Recursos + siguientes pasos

### Libros esenciales
- Kent Beck, *Test-Driven Development: By Example* (2002). Todavía la mejor introducción a TDD.
- Martin Fowler, *Refactoring: Improving the Design of Existing Code*, 2ª ed. (2018). Catálogo canónico.
- Michael Feathers, *Working Effectively with Legacy Code* (2004). Biblia para código legacy.
- Steve Freeman, Nat Pryce, *Growing Object-Oriented Software Guided by Tests* (2009). "GOOS". TDD outside-in.
- Titus Winters, Tom Manshreck, Hyrum Wright, *Software Engineering at Google* (2020). Prácticas industriales a escala.
- Sandi Metz, *Practical Object-Oriented Design in Ruby* (2ª ed. 2018). Menos código, mejor código.

### Charlas y papers
- Ian Cooper, "TDD, Where Did It All Go Wrong" (2017). Diagnóstico de mal uso de mocks.
- Sandi Metz, "The Wrong Abstraction" (2016).
- Kent Beck, "Test Desiderata" (serie de artículos, 2019). 12 propiedades de un buen test.
- Kent C. Dodds, "Testing Trophy" (2018). Evolución del thinking sobre la pirámide.
- Just et al., "Are Mutants a Valid Substitute for Real Faults?" (FSE 2014). Validación empírica de mutation testing.

### Herramientas 2026
- Java: JUnit 5, AssertJ, Mockito, Pitest, Testcontainers, ArchUnit, Approvaltests.
- JS/TS: Jest o Vitest, fast-check (property-based), Stryker (mutation), Testing Library, Playwright (E2E), Pact (contract).
- Python: pytest, hypothesis, mutmut, tox, pytest-randomly, Testcontainers-python.
- Contract testing: Pact, Spring Cloud Contract, Schemathesis.
- Chaos: Gremlin, Litmus, AWS Fault Injection Simulator.

### Siguientes pasos en el track
- Pasa a [Cap 05 — APIs y seguridad](./05-apis-y-seguridad.md) para aplicar contract testing y OWASP en tus endpoints.
- Consulta [Cap 03 — concurrencia y async](./03-concurrencia-y-async.md) si tu código bajo test es concurrente (los tests concurrentes tienen su propia disciplina).
- Practica sobre proyectos open source reales: la mayoría de repos en GitHub bien mantenidos son laboratorios de testing profesional. Recomendados: Spring Boot, Micronaut, Quarkus, Guava, Caffeine.

---

## 10. Preguntas de práctica

Las 20 preguntas del simulacro cubren: pirámide de tests, test doubles, tests frágiles vs robustos, characterization tests, code smells (Long Method, Primitive Obsession, Feature Envy), TDD Red/Green/Refactor, flaky tests, Extract Method, Rule of Three, AAA/Given-When-Then, contract testing con Pact, property-based testing, refactor de Long Method, snapshot testing, Strangler Fig, Test Data Builder, deuda técnica y chaos engineering.

- **Sim JSON**: [`packages/content/src/tech/programmer/sim-04-testing-and-refactor.json`](../../packages/content/src/tech/programmer/sim-04-testing-and-refactor.json)
- **Ruta en la app**: `/practice/programmer/programmer-sim-04-testing-and-refactor`
- **Tiempo estimado**: 22 min · **Pass**: 75% (15/20 correctas)

Recomendación de estudio: haz el simulacro **antes** de terminar los ejercicios del §8 para calibrar tu nivel actual, y **de nuevo después** para medir tu progreso. Revisa cada `why` de las opciones incorrectas —muchas explican matices que rara vez se enseñan.

---

## Navegación

- [Índice](./README.md)
- Anterior: [Cap 03 — concurrencia y async](./03-concurrencia-y-async.md)
- Siguiente: [Cap 05 — APIs y seguridad →](./05-apis-y-seguridad.md)
