# Candor evaluation tasks

Write each solution in Candor, in its own file: `eval/attempts/<MODEL>/<task>.cnd` (for example `eval/attempts/opus/fizzbuzz.cnd`).

Rules:
- Each file declares exactly the types and functions that its task specifies, plus any private helper functions you want.
- **Do not write a `main` function.** A hidden test program will `use` your file and call your functions.
- Helper names must not collide across tasks. Prefix each helper with its task name, e.g. `topword_lower`.
- Use only the language described in `docs/llms.txt`.

---

## 1. fizzbuzz
`fn fizzbuzz(n: Int) -> [Str]`
Return the entries for 1..n in order: "FizzBuzz" if divisible by 15, "Fizz" if divisible by 3, "Buzz" if divisible by 5, otherwise the number as text. For n <= 0, return an empty array.

## 2. top_word
`fn top_word(text: Str) -> Str`
`text` holds lowercase ASCII words separated by one or more spaces (it may also start or end with spaces). Return the most frequent word. On a tie, return the tied word whose first occurrence is earliest. If there are no words, return "".

## 3. stack_machine
Declare this enum, with exactly these variant and field names:
```
type Instr = enum
  Push(value: Int)
  Add
  Mul
  Dup
  Swap
end type Instr
```
`fn run(prog: [Instr]) -> Int`
Run the instructions on an empty Int stack:
- Push puts its value on the stack.
- Add and Mul pop two values and push their sum or product.
- Dup pushes a copy of the top value.
- Swap exchanges the top two values.

Return the top of the stack at the end. You may assume the program is valid.

## 4. bank
Declare:
```
type Account = record
  owner: Str
  balance: Int
end type Account
```
- `fn deposit(inout acc: Account, amount: Int)`: adds `amount` to the balance. Precondition: amount > 0; state it as a contract.
- `fn withdraw(inout acc: Account, amount: Int) -> Bool`: if amount > 0 and amount <= balance, subtract it and return true. Otherwise leave the account unchanged and return false.

## 5. transpose
`fn transpose(m: [[Int]]) -> [[Int]]`
`m` is rectangular, with R rows of C columns each. Return its transpose: C rows of R columns. If `m` has no rows, return an empty array.

## 6. find
`fn find(xs: [Int], target: Int) -> Int`
`xs` is sorted ascending and has no duplicates. Return the index of `target`, or -1 if it isn't there. Use binary search.

## 7. lookup
Declare:
```
type Lookup = enum
  Found(index: Int)
  Missing
end type Lookup
```
`fn index_of(names: [Str], name: Str) -> Lookup`
Return `Found(i)` for the first i where `names[i] == name`, otherwise `Missing`.

## 8. csv
`fn parse_csv_ints(line: Str) -> [Int]`
`line` holds comma-separated decimal integers with no spaces. An integer may have a leading `-`. Example: `"12,-3,40"` gives `[12, -3, 40]`. The empty string gives `[]`.

## 9. summary
- `fn summarize(xs: [Int]) -> Str`: returns `"count=N sum=S max=M"`. Precondition: xs is non-empty; state it as a contract.
- `fn print_summary(xs: [Int])`: prints that line to stdout.
