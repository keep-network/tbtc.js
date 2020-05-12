import readline from  "readline"

const prompt = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
})

// Prompts for the question, waiting for valid answers or prefix thereof.
// Case insensitive to the entered answer, returns the selected answer from the
// valid list (not the user's input). If an invalid response is entered,
// presents an error and reprompts.
export default {
    promptQuestion: async function(question, validAnswers) {
        return this.promptValidInput(
            question,
            (found) => validAnswers.find(_ => _.toLowerCase().startsWith(found.toLowerCase())),
            "Invalid answer, try one of: [" + validAnswers.join("/") + "].",
        )
    },

    promptValidInput: async function(question, inputCheckFn, retryText) {
        const answer = await this.promptInput(question)
        const validAnswer = inputCheckFn(answer)

        if (answer && validAnswer) {
            return (typeof validAnswer == "boolean" ? answer : validAnswer)
        } else {
            const retry = retryText || "Invalid answer, try again.".red
            console.log(retry)
            return this.promptValidInput(question, inputCheckFn, retryText)
        }
    },

    promptInput: function(question) {
        return new Promise((resolve) => {
            prompt.question(question + " ", (answer) => {
                resolve(answer)
            })
        })
    }
}
