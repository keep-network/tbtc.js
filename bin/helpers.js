// Tools for consuming arguments functionally.
// In particular, these helpers are designed to consume from an argument list
// and return copies of that argument list with consumed arguments removed.

/**
 * Finds an argument named `argName` in the list of arguments and returns an
 * object with the index of the argument in the original argument list, and the
 * remaining arguments without the matching argument.
 *
 * @param {string[]} args The list of all command-line arguments.
 * @param {string} argName The name of an argument to look for.
 * @return {{index: number, remaining: string[]}} An object with the index of
 *         the matching argument in the original args list, and a list of
 *         remaining arguments with the matching one removed. The index will be
 *         -1 if the argument was not found, and the `remaining` list will have
 *         the same elements as `args` in that case.
 */
export function findAndConsumeArg(args, argName) {
  const index = args.indexOf(argName)
  return {
    index,
    remaining:
      index < 0
        ? args.slice(0)
        : args.slice(0, index).concat(args.slice(index + 1))
  }
}

/**
 * Finds an argument named `argName` in the list of arguments and returns an
 * object with a boolean `existence` indicating whether the argument was found,
 * and `remaining` set to the remaining arguments without the matching argument.
 *
 * @param {string[]} args The list of all command-line arguments.
 * @param {string} argName The name of an argument to look for.
 * @return {{existence: boolean, remaining: string[]}} An object with a boolean
 *         `existence` set to `true` if the argument was found or `false`
 *         otherwise , and a list of remaining arguments with the matching one
 *         removed. The `remaining` list will have the same elements as `args`
 *         if the argument was not found.
 */
export function findAndConsumeArgExistence(args, argName) {
  const { index, remaining } = findAndConsumeArg(args, argName)
  return { existence: index != -1, remaining }
}

/** @typedef {{ [x: string]: boolean }} FoundArgsExistence */
/** @typedef {{ [x: string]: string|null }} FoundArgsValues */

/**
 * Finds the set of argument names in `argsToCheck`, accumulating a map of
 * argument names to booleans indicating if they were found in the list of
 * arguments or not, and returns an object with `found` set to that map and
 * the remaining arguments without any matching arguments.
 *
 * Note that arguments in the `found` list have leading `-` characters stripped
 * and turn mid-word `-` into camel case, so e.g. "--debug" turns into "debug",
 * "-v" turns into "v", and "--test-system" turns into "testSystem" in the
 * `found` map.
 *
 * Example usage:
 *
 *     const args = process.argv.slice(1) // drop command name
 *     const {
 *         found: { debug, verbose, version },
 *         remaining: nonBooleanArgs
 *     } = findAndConsumeArgsExistence(args, "--debug", "--verbose", "--version")
 *
 *     // debug, verbose, version are true if --debug, --verbose, or --version
 *     // were passed; nonBooleanArgs only contains any parameters that were NOT
 *     // --debug, --verbose, or --version.
 *
 * @param {string[]} args The list of all command-line arguments.
 * @param {string[]} argsToCheck The names of arguments to look for.
 * @return {{found: FoundArgsExistence, remaining: string[]}} An object with
 *         two properties: `found` maps argument names from `argsToCheck` to
 *         a boolean indicating whether that argument name was found;
 *         `remaining` has a list of remaining arguments with any matches from
 *         `argsToCheck` removed. The `remaining` list will have the same
 *         elements as `args` if none of the `argsToCheck` were found.
 */
export function findAndConsumeArgsExistence(args, ...argsToCheck) {
  return argsToCheck.reduce(
    ({ found, remaining }, argToCheck) => {
      const {
        existence,
        remaining: postCheckArgs
      } = findAndConsumeArgExistence(remaining, argToCheck)
      return {
        found: Object.assign(found, { [camelCase(argToCheck)]: existence }),
        remaining: postCheckArgs
      }
    },
    { found: {}, remaining: args }
  )
}

/**
 * Finds an argument named `argName` in the list of arguments and returns an
 * object with `value` set to the argument after it, and `remaining` set to the
 * remaining arguments without the matching argument and its immediately
 * subsequent value. This is designed to consume a flag like `--address magic`
 * and read the value `magic`.
 *
 * @param {string[]} args The list of all command-line arguments.
 * @param {string} argName The name of an argument to look for.
 * @return {{value: string?, remaining: string[]}} An object with a `value`
 *         property set to the argument after the matching argument name (if
 *         found) if the argument was found or `null` otherwise, and a list of
 *         remaining arguments with the matching one and its value removed. The
 *         `remaining` list will have the same elements as `args` if the
 *         argument was not found.
 */
export function findAndConsumeArgValue(args, argName) {
  const { index, remaining } = findAndConsumeArg(args, argName)
  const value = remaining[index]

  if (index == -1) {
    return { value: null, remaining }
  } else {
    return {
      value: value,
      remaining: remaining.slice(0, index).concat(args.slice(index + 2))
    }
  }
}

/**
 * Finds the set of argument names in `argsToCheck`, accumulating a map of
 * argument names to values read as the next element in the args list arguments
 * or not, and returns an object with `found` set to that map and
 * the remaining arguments without any matching arguments.
 *
 * Note that arguments in the `found` list have leading `-` characters stripped
 * and turn mid-word `-` into camel case, so e.g. "--debug" turns into "debug",
 * "-v" turns into "v", and "--test-system" turns into "testSystem" in the
 * `found` map. Note also that arguments that were not found have their values
 * set to `null`.
 *
 * Example usage:
 *
 *     const args = process.argv.slice(1) // drop command name
 *     const {
 *         found: { address, account, rpc },
 *         remaining: otherArgs
 *     } = findAndConsumeArgsExistence(args, "--address", "--account", "--rpc")
 *
 *     // For `--address 0x1234 --account boom`, `address` will be set to
 *     // `0x1234`, `account` will be set to `boom`, and `rpc` will be set to
 *     // `null`; nonBooleanArgs only contains any parameters that were NOT
 *     // --address, --account, or --rpc.
 *
 * @param {string[]} args The list of all command-line arguments.
 * @param {string[]} argsToCheck The names of arguments to look for.
 * @return {{found: FoundArgsValues, remaining: string[]}} An object with
 *         two properties: `found` maps argument names from `argsToCheck` to
 *         values found as the next item in the args list; `remaining` has a list of
 *         remaining arguments with any matches from `argsToCheck` removed. The
 *         `remaining` list will have the same elements as `args` if none of the
 *         `argsToCheck` were found.
 */
export function findAndConsumeArgsValues(args, ...argsToCheck) {
  return argsToCheck.reduce(
    ({ found, remaining }, argToCheck) => {
      const { value, remaining: postCheckArgs } = findAndConsumeArgValue(
        remaining,
        argToCheck
      )
      return {
        found: Object.assign(found, { [camelCase(argToCheck)]: value }),
        remaining: postCheckArgs
      }
    },
    { found: {}, remaining: args }
  )
}

/**
 * Takes an argument name and camel-cases it by dropping all leading `-` and
 * turning any interstitial `-<letter>` into an uppercase of the letter.
 *
 * @param {string} argName The name of a command-line argument, typically as a
 *        --dashed-name.
 * @return {string} The argument name, which is typically a --dashed-name, as a
 *         camel-cased version (e.g. "dashedName").
 */
function camelCase(argName) {
  return argName
    .replace(/^-*/, "")
    .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}
