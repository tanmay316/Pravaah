/**
 * Free course content. Bundled with the app so lessons cost nothing to serve and work offline.
 * Each lesson targets a mistake Hindi speakers commonly make in English.
 */

export type Exercise =
  | {
      type: "choice";
      prompt: string;
      sentence?: string;
      options: string[];
      answer: number;
      explanation: string;
    }
  | {
      type: "translate";
      prompt: string;
      hindi: string;
      options: string[];
      answer: number;
      explanation: string;
    }
  | {
      type: "order";
      prompt: string;
      hindi?: string;
      answer: string;
      extra?: string[];
      explanation: string;
    }
  | {
      type: "listen";
      prompt: string;
      audio: string;
      options: string[];
      answer: number;
      explanation: string;
    };

export interface CourseLesson {
  id: string;
  title: string;
  description: string;
  tip: { title: string; english: string; hindi: string; examples: string[] };
  exercises: Exercise[];
}

export interface CourseUnit {
  id: string;
  title: string;
  description: string;
  lessons: CourseLesson[];
}

export const COURSE: CourseUnit[] = [
  {
    id: "unit-basics",
    title: "Everyday basics",
    description: "Introduce yourself and talk about your day",
    lessons: [
      {
        id: "basics-introduce",
        title: "Introduce yourself",
        description: "am, is, are and simple introductions",
        tip: {
          title: "am / is / are",
          english: "Use am with I, is with he/she/it and one person, and are with you, we and they.",
          hindi: "I के साथ am, he/she/it के साथ is, और you/we/they के साथ are लगाते हैं।",
          examples: ["I am a software engineer.", "She is from Pune.", "They are my colleagues."],
        },
        exercises: [
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "I ___ from Lucknow.",
            options: ["is", "am", "are"],
            answer: 1,
            explanation: "With I, always use am: I am from Lucknow.",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "My parents ___ teachers.",
            options: ["are", "is", "am"],
            answer: 0,
            explanation: "My parents means they, so use are.",
          },
          {
            type: "translate",
            prompt: "Pick the best English sentence",
            hindi: "मेरा नाम रिया है और मैं 24 साल की हूँ।",
            options: [
              "My name is Riya and I am 24 years old.",
              "My name is Riya and I have 24 years.",
              "I am name Riya and I am 24 year.",
            ],
            answer: 0,
            explanation: "In English we say I am 24 years old, not I have 24 years.",
          },
          {
            type: "listen",
            prompt: "Tap what you hear",
            audio: "Nice to meet you. I work in a bank.",
            options: [
              "Nice to meet you. I work in a bank.",
              "Nice to meet you. I walk to the bank.",
              "Nice to see you. I work in a band.",
            ],
            answer: 0,
            explanation: "Nice to meet you is the standard reply when you meet someone new.",
          },
          {
            type: "order",
            prompt: "Put the words in order",
            hindi: "मैं एक आईटी कंपनी में काम करता हूँ।",
            answer: "I work in an IT company",
            extra: ["am"],
            explanation: "For your job, use the present simple: I work in an IT company.",
          },
          {
            type: "choice",
            prompt: "Which sentence is correct?",
            options: ["He is having two brothers.", "He has two brothers.", "He have two brothers."],
            answer: 1,
            explanation: "Have is not used in the -ing form for possession. He has two brothers.",
          },
          {
            type: "choice",
            prompt: "Choose the most natural reply",
            sentence: "Thank you so much for your help!",
            options: ["Mention not.", "You're welcome.", "No mention."],
            answer: 1,
            explanation: "Mention not is common in India but sounds odd elsewhere. Say You're welcome or No problem.",
          },
          {
            type: "listen",
            prompt: "Tap what you hear",
            audio: "I'm from Jaipur, but I live in Bangalore now.",
            options: [
              "I'm from Jaipur, but I live in Bangalore now.",
              "I'm from Jaipur, but I left Bangalore now.",
              "I came from Jaipur, and I live in Bangalore.",
            ],
            answer: 0,
            explanation: "I'm is the short form of I am. Native speakers almost always use it.",
          },
        ],
      },
      {
        id: "basics-routine",
        title: "Your daily routine",
        description: "Present simple and the he/she -s",
        tip: {
          title: "Add -s for he, she and it",
          english: "In the present simple, add -s or -es to the verb after he, she, it or one person's name.",
          hindi: "Present simple में he/she/it या किसी एक व्यक्ति के नाम के बाद verb में -s या -es लगाते हैं।",
          examples: ["She goes to the gym every morning.", "My father reads the newspaper.", "It rains a lot in July."],
        },
        exercises: [
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "My sister ___ to college by bus.",
            options: ["go", "goes", "going"],
            answer: 1,
            explanation: "My sister is she, so add -es: goes.",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "We ___ dinner at 9 pm.",
            options: ["has", "have", "having"],
            answer: 1,
            explanation: "With we, use the base verb: have.",
          },
          {
            type: "choice",
            prompt: "Which sentence is correct?",
            options: [
              "He work from home on Fridays.",
              "He works from home on Fridays.",
              "He is work from home on Fridays.",
            ],
            answer: 1,
            explanation: "He + works. Do not add is before a present simple verb.",
          },
          {
            type: "translate",
            prompt: "Pick the best English sentence",
            hindi: "मैं रोज़ सुबह छह बजे उठता हूँ।",
            options: [
              "I am waking up at six every morning.",
              "I wake up at six every morning.",
              "I wakes up at six every morning.",
            ],
            answer: 1,
            explanation: "Habits use the present simple: I wake up at six every morning.",
          },
          {
            type: "order",
            prompt: "Put the words in order",
            hindi: "वह हर शाम टहलने जाती है।",
            answer: "She goes for a walk every evening",
            extra: ["go"],
            explanation: "She + goes. Go for a walk is a fixed phrase.",
          },
          {
            type: "listen",
            prompt: "Tap what you hear",
            audio: "He usually takes the metro to work.",
            options: [
              "He usually takes the metro to work.",
              "He usually took the metro to work.",
              "He used to take the metro to work.",
            ],
            answer: 0,
            explanation: "Usually + present simple describes a habit: he usually takes.",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "The shop ___ at 10 am.",
            options: ["open", "opens", "is open at"],
            answer: 1,
            explanation: "The shop is it, so add -s: opens.",
          },
        ],
      },
      {
        id: "basics-questions",
        title: "Asking questions",
        description: "do, does and question word order",
        tip: {
          title: "Questions need do or does",
          english: "For present simple questions use Do/Does + subject + base verb. After does, the verb has no -s.",
          hindi: "Present simple के सवाल में Do/Does + subject + base verb आता है। Does के बाद verb में -s नहीं लगता।",
          examples: ["Do you like cricket?", "Where does she work?", "What time does the train leave?"],
        },
        exercises: [
          {
            type: "choice",
            prompt: "Which question is correct?",
            options: ["Where you live?", "Where do you live?", "Where you are living?"],
            answer: 1,
            explanation: "Question word + do + you + verb: Where do you live?",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "___ your brother play the guitar?",
            options: ["Do", "Does", "Is"],
            answer: 1,
            explanation: "Your brother is he, so use Does.",
          },
          {
            type: "choice",
            prompt: "Which question is correct?",
            options: ["What does he wants?", "What does he want?", "What he wants?"],
            answer: 1,
            explanation: "After does, use the base verb: want, not wants.",
          },
          {
            type: "translate",
            prompt: "Pick the best English question",
            hindi: "तुम्हारा ऑफिस कितने बजे शुरू होता है?",
            options: [
              "What time your office starts?",
              "What time does your office start?",
              "What time is your office start?",
            ],
            answer: 1,
            explanation: "What time + does + your office + start?",
          },
          {
            type: "order",
            prompt: "Put the words in order",
            hindi: "क्या तुम्हें मसालेदार खाना पसंद है?",
            answer: "Do you like spicy food",
            extra: ["are"],
            explanation: "Do + you + like ... is the natural question form.",
          },
          {
            type: "listen",
            prompt: "Tap what you hear",
            audio: "How often do you visit your parents?",
            options: [
              "How often do you visit your parents?",
              "How soon do you visit your parents?",
              "How often did you visit your parents?",
            ],
            answer: 0,
            explanation: "How often asks about frequency: once a week, every month.",
          },
          {
            type: "choice",
            prompt: "Choose the polite way to ask",
            options: ["What is your good name?", "May I know your name?", "Tell your name."],
            answer: 1,
            explanation: "May I know your name? is polite and natural. What is your good name? sounds unusual outside India.",
          },
        ],
      },
      {
        id: "basics-articles",
        title: "a, an and the",
        description: "Articles Hindi speakers often skip",
        tip: {
          title: "a / an / the",
          english: "Use a or an for one thing mentioned for the first time, and the when the listener knows which one. Use an before a vowel sound.",
          hindi: "पहली बार किसी एक चीज़ की बात करते समय a/an, और जब सुनने वाला जानता हो कि कौन-सी चीज़, तब the लगाते हैं। Vowel sound से पहले an आता है।",
          examples: ["I bought a phone. The phone is very fast.", "She is an engineer.", "It takes an hour."],
        },
        exercises: [
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "My brother is ___ doctor.",
            options: ["a", "an", "the"],
            answer: 0,
            explanation: "Jobs need a or an: He is a doctor.",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "I waited for ___ hour.",
            options: ["a", "an", "no article"],
            answer: 1,
            explanation: "Hour starts with a vowel sound (our), so use an.",
          },
          {
            type: "choice",
            prompt: "Which sentence is correct?",
            options: [
              "I have meeting at 3 pm.",
              "I have a meeting at 3 pm.",
              "I have the meeting on 3 pm.",
            ],
            answer: 1,
            explanation: "One meeting mentioned for the first time: a meeting. Times use at.",
          },
          {
            type: "translate",
            prompt: "Pick the best English sentence",
            hindi: "मैंने एक कार खरीदी। कार लाल रंग की है।",
            options: [
              "I bought car. Car is red.",
              "I bought a car. The car is red.",
              "I bought the car. A car is red.",
            ],
            answer: 1,
            explanation: "First mention: a car. Second mention, we know which: the car.",
          },
          {
            type: "order",
            prompt: "Put the words in order",
            answer: "She is an honest person",
            extra: ["a"],
            explanation: "Honest starts with a vowel sound (onest), so use an.",
          },
          {
            type: "listen",
            prompt: "Tap what you hear",
            audio: "Can you close the window, please?",
            options: [
              "Can you close the window, please?",
              "Can you close a window, please?",
              "Could you clean the window, please?",
            ],
            answer: 0,
            explanation: "The window: both of you know which window.",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "He is ___ best player in our team.",
            options: ["a", "the", "an"],
            answer: 1,
            explanation: "Superlatives like best always take the.",
          },
        ],
      },
    ],
  },
  {
    id: "unit-past",
    title: "Talking about the past",
    description: "Tell stories about what happened",
    lessons: [
      {
        id: "past-simple",
        title: "Yesterday and last week",
        description: "Regular and irregular past verbs",
        tip: {
          title: "Past simple",
          english: "Use the past simple for finished actions. Regular verbs add -ed; common irregular verbs change: go → went, buy → bought, eat → ate.",
          hindi: "बीते हुए और ख़त्म हो चुके काम के लिए past simple लगाते हैं। Regular verbs में -ed लगता है; कुछ verbs बदल जाते हैं: go → went, buy → bought।",
          examples: ["I watched a film last night.", "We went to Goa in May.", "She bought a new laptop."],
        },
        exercises: [
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "Yesterday I ___ to the market.",
            options: ["go", "went", "gone"],
            answer: 1,
            explanation: "Yesterday is finished time, so use the past: went.",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "We ___ pizza last night.",
            options: ["eat", "eated", "ate"],
            answer: 2,
            explanation: "Eat is irregular: eat → ate.",
          },
          {
            type: "translate",
            prompt: "Pick the best English sentence",
            hindi: "मैंने कल एक शर्ट ख़रीदी।",
            options: ["I buy one shirt yesterday.", "I bought a shirt yesterday.", "I have bought a shirt yesterday."],
            answer: 1,
            explanation: "Buy → bought. With yesterday, do not use have bought.",
          },
          {
            type: "order",
            prompt: "Put the words in order",
            hindi: "हम पिछले महीने शिमला गए थे।",
            answer: "We went to Shimla last month",
            extra: ["go"],
            explanation: "Last month is finished time: went.",
          },
          {
            type: "listen",
            prompt: "Tap what you hear",
            audio: "She called me after the meeting.",
            options: ["She called me after the meeting.", "She calls me after the meeting.", "She'll call me after the meeting."],
            answer: 0,
            explanation: "Listen for the -ed ending: called.",
          },
          {
            type: "choice",
            prompt: "Which sentence is correct?",
            options: ["I have seen him yesterday.", "I saw him yesterday.", "I see him yesterday."],
            answer: 1,
            explanation: "With a finished time like yesterday, use the past simple: I saw him.",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "The train ___ late this morning.",
            options: ["arrive", "arrived", "arriving"],
            answer: 1,
            explanation: "This morning is over, so arrive → arrived.",
          },
          {
            type: "listen",
            prompt: "Tap what you hear",
            audio: "We stayed at home because it was raining.",
            options: [
              "We stayed at home because it was raining.",
              "We stay at home because it is raining.",
              "We stayed at home because it rained a lot.",
            ],
            answer: 0,
            explanation: "Was raining describes the background; stayed is the finished action.",
          },
        ],
      },
      {
        id: "past-didnt",
        title: "didn't + base verb",
        description: "Negatives and questions in the past",
        tip: {
          title: "After did, use the base verb",
          english: "In past negatives and questions, did already shows the past. So the main verb stays in its base form: didn't go, did you see.",
          hindi: "Past के negative और सवाल में did पहले से past बताता है, इसलिए main verb base form में रहता है: didn't go, did you see।",
          examples: ["I didn't go to office today.", "Did you finish the report?", "She didn't call me back."],
        },
        exercises: [
          {
            type: "choice",
            prompt: "Which sentence is correct?",
            options: ["I didn't went to office.", "I didn't go to office.", "I not went to office."],
            answer: 1,
            explanation: "Didn't + base verb: didn't go.",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "Did you ___ the match last night?",
            options: ["watched", "watch", "watching"],
            answer: 1,
            explanation: "After did, use the base verb: watch.",
          },
          {
            type: "choice",
            prompt: "Which question is correct?",
            options: ["Where did you went?", "Where you went?", "Where did you go?"],
            answer: 2,
            explanation: "Where + did + you + go?",
          },
          {
            type: "translate",
            prompt: "Pick the best English sentence",
            hindi: "उसने मुझे कुछ नहीं बताया।",
            options: ["He didn't told me anything.", "He didn't tell me anything.", "He not told me anything."],
            answer: 1,
            explanation: "Didn't + tell. Anything is used with negatives.",
          },
          {
            type: "order",
            prompt: "Put the words in order",
            hindi: "क्या तुमने खाना खाया?",
            answer: "Did you have lunch",
            extra: ["had"],
            explanation: "Did + you + have. Have lunch is more natural than eat lunch.",
          },
          {
            type: "listen",
            prompt: "Tap what you hear",
            audio: "I didn't get your message on time.",
            options: ["I didn't get your message on time.", "I don't get your message on time.", "I did get your message on time."],
            answer: 0,
            explanation: "Didn't get: the message did not arrive in the past.",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "We didn't ___ any tickets.",
            options: ["bought", "buy", "buying"],
            answer: 1,
            explanation: "Didn't + base verb: buy.",
          },
        ],
      },
      {
        id: "past-since-for",
        title: "Since and for",
        description: "Talking about how long",
        tip: {
          title: "have been + -ing with since / for",
          english: "For something that started in the past and is still true, use have been + -ing (or have + past participle). Since + a starting point, for + a length of time.",
          hindi: "जो काम past में शुरू हुआ और अब भी चल रहा है, उसके लिए have been + -ing लगाते हैं। Since के साथ शुरुआत का समय, for के साथ कितनी देर।",
          examples: ["I have been working here since 2020.", "She has lived in Delhi for ten years.", "We have known each other since college."],
        },
        exercises: [
          {
            type: "choice",
            prompt: "Which sentence is correct?",
            options: [
              "I am working here since 2020.",
              "I have been working here since 2020.",
              "I work here since 2020.",
            ],
            answer: 1,
            explanation: "Started in the past and still true: have been working.",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "She has been waiting ___ two hours.",
            options: ["since", "for", "from"],
            answer: 1,
            explanation: "Two hours is a length of time: for.",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "They have lived here ___ 2015.",
            options: ["since", "for", "from"],
            answer: 0,
            explanation: "2015 is a starting point: since.",
          },
          {
            type: "translate",
            prompt: "Pick the best English sentence",
            hindi: "मैं तीन साल से अंग्रेज़ी सीख रहा हूँ।",
            options: [
              "I am learning English since three years.",
              "I have been learning English for three years.",
              "I learn English from three years.",
            ],
            answer: 1,
            explanation: "Have been learning + for three years. Avoid since three years.",
          },
          {
            type: "order",
            prompt: "Put the words in order",
            answer: "We have known each other for ten years",
            extra: ["since"],
            explanation: "Know is not used with -ing here: have known. Ten years is a length: for.",
          },
          {
            type: "listen",
            prompt: "Tap what you hear",
            audio: "How long have you been living in Mumbai?",
            options: [
              "How long have you been living in Mumbai?",
              "How long are you living in Mumbai?",
              "How long did you live in Mumbai?",
            ],
            answer: 0,
            explanation: "How long have you been ... asks about something still going on.",
          },
        ],
      },
    ],
  },
  {
    id: "unit-work",
    title: "Work and real life",
    description: "Sound clear and professional",
    lessons: [
      {
        id: "work-requests",
        title: "Polite requests",
        description: "Ask for help naturally at work",
        tip: {
          title: "Could you ...? / Would you mind ...?",
          english: "Soften requests with Could you, Would you mind + -ing, or Can I. Avoid commands and avoid Please do the needful, which sounds old-fashioned.",
          hindi: "Request को नरम बनाने के लिए Could you, Would you mind + -ing या Can I लगाएँ। सीधे आदेश और Please do the needful से बचें।",
          examples: ["Could you send me the file?", "Would you mind checking this once?", "Can I call you back in ten minutes?"],
        },
        exercises: [
          {
            type: "choice",
            prompt: "Which request sounds most professional?",
            options: ["Send me the report.", "Please do the needful.", "Could you send me the report by 5 pm?"],
            answer: 2,
            explanation: "Could you + a clear action and deadline is polite and specific.",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "Would you mind ___ the door?",
            options: ["close", "closing", "to close"],
            answer: 1,
            explanation: "Would you mind is followed by -ing: closing.",
          },
          {
            type: "translate",
            prompt: "Pick the best English sentence",
            hindi: "क्या आप मुझे दस मिनट बाद कॉल कर सकते हैं?",
            options: [
              "Can you call me after ten minutes?",
              "Could you call me back in ten minutes?",
              "You call me ten minutes later.",
            ],
            answer: 1,
            explanation: "In ten minutes means from now. Call back means return a call.",
          },
          {
            type: "order",
            prompt: "Put the words in order",
            answer: "Could you please share the meeting link",
            extra: ["do"],
            explanation: "Could you please + verb is a polite request.",
          },
          {
            type: "listen",
            prompt: "Tap what you hear",
            audio: "Sorry, could you repeat that more slowly?",
            options: [
              "Sorry, could you repeat that more slowly?",
              "Sorry, could you report that more slowly?",
              "Sorry, can you repeat that one more time?",
            ],
            answer: 0,
            explanation: "A very useful phrase when you did not understand someone.",
          },
          {
            type: "choice",
            prompt: "Which reply is natural?",
            sentence: "Can you join the call at 4?",
            options: ["Yes, sure. I'll be there.", "Yes, I will join, no?", "Yes, I am joining sure."],
            answer: 0,
            explanation: "Yes, sure. I'll be there. is short, clear and friendly.",
          },
        ],
      },
      {
        id: "work-prepositions",
        title: "in, on and at",
        description: "Prepositions of time",
        tip: {
          title: "in / on / at for time",
          english: "Use at for clock times, on for days and dates, and in for months, years and parts of the day.",
          hindi: "घड़ी के समय के लिए at, दिन और तारीख़ के लिए on, और महीने, साल और दिन के हिस्सों के लिए in लगाते हैं।",
          examples: ["The meeting is at 10:30.", "I was born on 5 June.", "We moved to Pune in 2019."],
        },
        exercises: [
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "The interview is ___ Monday.",
            options: ["in", "on", "at"],
            answer: 1,
            explanation: "Days take on: on Monday.",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "My shift starts ___ 9 pm.",
            options: ["at", "on", "in"],
            answer: 0,
            explanation: "Clock times take at: at 9 pm.",
          },
          {
            type: "choice",
            prompt: "Choose the correct word",
            sentence: "We usually travel ___ December.",
            options: ["on", "at", "in"],
            answer: 2,
            explanation: "Months take in: in December.",
          },
          {
            type: "translate",
            prompt: "Pick the best English sentence",
            hindi: "मैं सुबह जल्दी पढ़ाई करता हूँ।",
            options: ["I study early at morning.", "I study early in the morning.", "I study early on morning."],
            answer: 1,
            explanation: "Parts of the day take in the: in the morning. But at night.",
          },
          {
            type: "order",
            prompt: "Put the words in order",
            answer: "The project ends on 30 June",
            extra: ["in"],
            explanation: "A specific date takes on.",
          },
          {
            type: "listen",
            prompt: "Tap what you hear",
            audio: "Let's meet at the weekend, maybe on Sunday evening.",
            options: [
              "Let's meet at the weekend, maybe on Sunday evening.",
              "Let's meet in the weekend, maybe in Sunday evening.",
              "Let's meet this weekend, maybe Sunday morning.",
            ],
            answer: 0,
            explanation: "At the weekend (British) or on the weekend (American). On Sunday evening uses on because of the day.",
          },
        ],
      },
      {
        id: "work-indianisms",
        title: "Sound more natural",
        description: "Fix common Indian English phrases",
        tip: {
          title: "Small fixes, big difference",
          english: "Some phrases are common in India but sound odd to international listeners: revert back, discuss about, cousin brother, prepone. Learn the simpler international version.",
          hindi: "कुछ phrases भारत में आम हैं पर बाहर के लोगों को अजीब लगते हैं, जैसे revert back, discuss about, cousin brother। इनके सरल international रूप सीखें।",
          examples: ["Please reply by Friday.", "Let's discuss the plan.", "He is my cousin."],
        },
        exercises: [
          {
            type: "choice",
            prompt: "Which sentence sounds most natural?",
            options: ["Kindly revert back by Friday.", "Please reply by Friday.", "Revert me back on Friday."],
            answer: 1,
            explanation: "Revert means go back to a previous state. For emails, say reply or get back to me.",
          },
          {
            type: "choice",
            prompt: "Which sentence is correct?",
            options: ["Let's discuss about the budget.", "Let's discuss the budget.", "Let's discuss on the budget."],
            answer: 1,
            explanation: "Discuss already means talk about, so no about or on.",
          },
          {
            type: "choice",
            prompt: "Which sentence sounds most natural?",
            options: ["Rahul is my cousin brother.", "Rahul is my cousin.", "Rahul is my brother cousin."],
            answer: 1,
            explanation: "In English, cousin is used for both male and female cousins.",
          },
          {
            type: "translate",
            prompt: "Pick the best English sentence",
            hindi: "मीटिंग को एक घंटा पहले कर दिया गया है।",
            options: [
              "The meeting has been preponed by one hour.",
              "The meeting has been moved one hour earlier.",
              "The meeting is pre-shifted one hour.",
            ],
            answer: 1,
            explanation: "Prepone is understood in India but not abroad. Say moved earlier or brought forward.",
          },
          {
            type: "order",
            prompt: "Put the words in order",
            answer: "I will get back to you tomorrow",
            extra: ["revert"],
            explanation: "Get back to you means reply or follow up.",
          },
          {
            type: "listen",
            prompt: "Tap what you hear",
            audio: "I have a doubt about the second slide.",
            options: [
              "I have a doubt about the second slide.",
              "I have a question about the second slide.",
              "I had a doubt about the second slide.",
            ],
            answer: 0,
            explanation: "You heard doubt. Internationally, I have a question is clearer: doubt usually means you think something is untrue.",
          },
          {
            type: "choice",
            prompt: "Which sentence is correct?",
            options: ["I am having a laptop.", "I have a laptop.", "I am owning a laptop."],
            answer: 1,
            explanation: "For possession, use have without -ing: I have a laptop.",
          },
        ],
      },
    ],
  },
];

export const ALL_LESSONS: CourseLesson[] = COURSE.flatMap((unit) => unit.lessons);

export function findLesson(id: string): CourseLesson | undefined {
  return ALL_LESSONS.find((lesson) => lesson.id === id);
}

/** Lessons unlock in order; the next one opens once the previous one is finished. */
export function isLessonUnlocked(id: string, completed: Record<string, unknown>): boolean {
  const index = ALL_LESSONS.findIndex((lesson) => lesson.id === id);
  if (index <= 0) return index === 0;
  return Boolean(completed[ALL_LESSONS[index - 1].id]);
}

/** XP needed to reach each level grows gently: 50, 150, 300, 500 ... */
export function levelForXp(xp: number): { level: number; current: number; needed: number } {
  let level = 1;
  let floor = 0;
  while (xp >= floor + level * 50) {
    floor += level * 50;
    level += 1;
  }
  return { level, current: xp - floor, needed: level * 50 };
}
