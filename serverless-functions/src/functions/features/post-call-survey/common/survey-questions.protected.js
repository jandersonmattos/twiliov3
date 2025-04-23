const TaskOperations = require(Runtime.getFunctions()['common/twilio-wrappers/taskrouter'].path);
const { twilioExecute } = require(Runtime.getFunctions()['common/helpers/function-helper'].path);
const jsforce = require('jsforce');

exports.handler = async (context, event, callback) => {
  console.log('PCS >> Incoming >>', event);

  const twiml = new Twilio.twiml.VoiceResponse();

  const { queueName, callSid, taskSid, surveyKey, Digits } = event;
  let { questionIndex, surveyTaskSid, attributes } = event;

  console.log(`questionIndex: ${questionIndex}`);
  console.log(`surveyTaskSid: ${surveyTaskSid}`);

  questionIndex = parseInt(questionIndex, 10);
  const digits = parseInt(Digits, 10);
  console.log(`attributes: ${attributes}`);
  attributes = attributes ? JSON.parse(attributes) : { conversations: {} };
  console.log('attributes 2:', attributes);

  // UPDATE: Rethink serverless wrappers #492
  const result = await twilioExecute(context, async (client) => {
    try {
      return await client.sync.v1
        .services(context.TWILIO_FLEX_SYNC_SID)
        .syncMaps(context.TWILIO_FLEX_POST_CALL_SURVEY_SYNC_MAP_SID)
        .syncMapItems(surveyKey)
        .fetch();
    } catch (error) {
      console.log(error);
      twiml.say({language: 'pt-BR'},"I'm sorry an error occurred in the post call survey. Goodbye. ");
      // Re-throw the error for the retry handler to catch
      return callback(null, twiml);
    }
  });

  if (result.success) {
    console.log('Twilio Fetch Survey from sync API response:', result.data);
    console.log(JSON.stringify(result.data));
  }

  const mapItem = result.data;
  console.log('mapItem: ', mapItem);

  const survey = mapItem.data;
  console.log('survey:', survey);

  if (questionIndex === 0) {
    console.log('entrou aqui');
    twiml.say({voice: 'Polly.Vitoria', language: 'pt-BR'}, survey.message_intro);

    const conversations = {
      conversation_id: taskSid,
      queue: queueName,
      virtual: 'Yes',
      abandoned: 'Yes',
      ivr_time: 0,
      talk_time: 0,
      ring_time: 0,
      queue_time: 0,
      wrap_up_time: 0,
      kind: 'Survey',
    };

    attributes.conversations = conversations;

    const taskResult = await TaskOperations.createTask({
      context,
      workflowSid: context.TWILIO_FLEX_POST_CALL_SURVEY_WORKFLOW_SID,
      taskChannel: 'voice',
      attributes,
      timeout: 300,
    });

    console.log('create taskResult', taskResult);
    surveyTaskSid = taskResult.data.sid;
    console.log(`Survey task SID: ${surveyTaskSid}`);
    attributes = taskResult.data.attributes;
  } else {
    console.log('entrou aqui2');
    attributes.conversations[`conversation_label_${questionIndex}`] = survey.questions[questionIndex - 1].label;
    attributes.conversations[`conversation_attribute_${questionIndex}`] = digits;

    const updateTaskResult = await TaskOperations.updateTask({
      taskSid: surveyTaskSid,
      updateParams: { attributes: JSON.stringify(attributes) },
      context,
    });
    attributes = updateTaskResult.data.attributes || attributes;
  }
  console.log('entrou aqui3');
  if (questionIndex === survey.questions.length) {
    attributes.conversations.abandoned = 'No';
    console.log('taskSid', taskSid);

    const updateTaskResult = await TaskOperations.updateTask({
      taskSid: surveyTaskSid,
      updateParams: {
        reason: 'Survey completed',
        assignmentStatus: 'canceled',
        attributes: JSON.stringify(attributes),
      },
      context,
    });

    attributes = updateTaskResult.data.attributes || attributes;

    const { SALESFORCE_URL, SALESFORCE_USER_TWILIO, SALESFORCE_PASSWORD_TWILIO } = context;
    const credentials = {
      url: SALESFORCE_URL,
      user: SALESFORCE_USER_TWILIO,
      password: SALESFORCE_PASSWORD_TWILIO,
    };

    let body = {};

    body = {
      taskSID: surveyTaskSid,
      callSID: callSid
    };

    console.log('credentials ' + credentials);

    const conn = new jsforce.Connection({
      loginUrl: credentials.url,
    });
    await conn.login(credentials.user, credentials.password);
    try {
      response = await conn.apex.post('/survey-call/', body, function (err, res) {
        if (err) {
          console.error(err);
        }
        console.log('response: ', res);
      });
    } catch (err) {
      console.log('erro aqui');
      console.log(err);
    }


    twiml.say({voice: 'Polly.Vitoria', language: 'pt-BR'}, survey.message_end);
  } else {
    const question = survey.questions[parseInt(questionIndex, 10)];
    twiml.say({voice: 'Polly.Vitoria', language: 'pt-BR'}, question.prompt);
    const nextQuestion = questionIndex + 1;

    const nextUrl = `https://${
      context.DOMAIN_NAME
    }/features/post-call-survey/common/survey-questions?callSid=${callSid}&taskSid=${taskSid}&surveyKey=${surveyKey}&queueName=${queueName}&surveyTaskSid=${surveyTaskSid}&questionIndex=${nextQuestion}&attributes=${encodeURIComponent(
      JSON.stringify(attributes),
    )}`;

    console.log(`Next URL: ${nextUrl}`);

    twiml.gather({
      timeout: 10,
      numDigits: 1,
      method: 'POST',
      action: nextUrl,
      language: 'pt-BR',
    });
  }

  return callback(null, twiml);
};
