# Хорошие и плохие тесты

## Хорошие тесты

**Интеграционного стиля**: через реальные интерфейсы, без моков внутренних частей.

```typescript
// ХОРОШО: проверяет наблюдаемое поведение
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

Признаки:

- Проверяет поведение, важное пользователям/вызывающим
- Только публичный API
- Переживает внутренние рефакторинги
- Описывает ЧТО, а не КАК
- Одна логическая проверка на тест

## Плохие тесты

**Тесты деталей реализации**: привязаны к внутренней структуре.

```typescript
// ПЛОХО: тестирует детали реализации
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

Красные флаги:

- Моки внутренних участников
- Тестирование приватных методов
- Проверка количества/порядка вызовов
- Тест падает при рефакторинге без изменения поведения
- Имя теста описывает КАК, а не ЧТО
- Проверка обходным путём вместо интерфейса

```typescript
// ПЛОХО: обходит интерфейс для проверки
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

// ХОРОШО: проверяет через интерфейс
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

**Тавтологические тесты**: ожидаемое значение пересказывает реализацию — тест зелёный по построению.

```typescript
// ПЛОХО: ожидание вычислено тем же способом, что и в коде
test("calculateTotal sums line items", () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});

// ХОРОШО: ожидание — независимый известный литерал
test("calculateTotal sums line items", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```
