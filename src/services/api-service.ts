// import { TemplateModalUI } from "../ui/template-modal-ui";
// import { App, Notice, Editor, RequestUrlParam, EditorPosition } from "obsidian";
import TextGeneratorPlugin from "../main";
import ReqFormatter from "../api-request-formatter";
import ContextManager, { InputContext } from "../context-manager";
import debug from "debug";
import LLMProviderInterface from "src/LLMProviders/interface";
import { LLMProviderRegistery } from "src/LLMProviders";
import providerOptionsValidator from "src/LLMProviders/providerOptionsValidator";
import { TextGeneratorSettings } from "../types";
import { Handlebars } from "../helpers/handlebars-helpers";
import { Platform } from "obsidian";
const logger = debug("textgenerator:TextGenerator");

export default class RequestHandler {
  plugin: TextGeneratorPlugin;
  reqFormatter: ReqFormatter;
  contextManager: ContextManager;
  signalController?: AbortController;

  LLMProvider: LLMProviderInterface;

  constructor(plugin: TextGeneratorPlugin) {
    this.plugin = plugin;
    this.contextManager = new ContextManager(app, plugin);
    this.reqFormatter = new ReqFormatter(app, plugin, this.contextManager);

    this.setup();
  }

  async setup() {
    try {
      await this.loadllm();
    } catch (err: any) {
      this.plugin.handelError(err);
    }
  }

  async loadllm(name: string = this.plugin.settings.selectedProvider || "") {
    const llmList = LLMProviderRegistery.getList();

    const llm =
      LLMProviderRegistery.get(name) || LLMProviderRegistery.get(llmList[0]);

    if (llm && llm.id !== this.LLMProvider?.id) {
      console.log("loading llm", name);
      if (Platform.isMobile && llm.mobileSupport == false)
        throw `Mobile is not supported for the "${llm?.id}" LLM provider`;

      // @ts-ignore
      const instance = new llm({
        plugin: this.plugin,
      });

      await instance.load();

      this.LLMProvider = instance;
    }
  }

  async gen(
    prompt: string,
    settings: Partial<typeof this.plugin.settings> = {}
  ) {
    logger("gen ", {
      prompt,
      pluginSettings: this.plugin.settings,
      settings,
    });

    const { reqParams, bodyParams, provider, allParams } =
      this.reqFormatter.getRequestParameters(
        {
          prompt,
        },
        false,
        ""
      );

    if (!this.LLMProvider || provider.selectedProvider !== this.LLMProvider.id)
      await this.loadllm(provider.selectedProvider);

    await providerOptionsValidator(
      this.LLMProvider.provider,
      provider.providerOptions
    );

    try {
      const result = await this.LLMProvider.generate(
        bodyParams["messages"],
        {
          requestParams: {
            signal: this.signalController?.signal,
            ...reqParams,
          },
          ...allParams,
          stream: false,
          llmPredict: bodyParams["messages"]?.length == 1,
          otherOptions: this.plugin.settings.LLMProviderOptions,
        },
        undefined,
        provider.providerOptions
      );

      logger("gen results", {
        result,
      });

      return result;
    } catch (error) {
      logger("gen  error", error);
      return Promise.reject(error);
    }
  }

  async streamGenerate(
    context: InputContext,
    insertMetadata = false,
    params: Partial<TextGeneratorSettings> = {},
    templatePath = "",
    additionnalParams: {
      showSpinner?: boolean;
      /** when using custom signal, it will not use textgenerator processing, loading or throw an error when 2 generations */
      signal?: AbortSignal;
      reqParams?: RequestInit | undefined;
      bodyParams?: any;
    } = {
      showSpinner: true,
      signal: undefined,
    }
  ) {
    try {
      logger("generate", {
        context,
        insertMetadata,
        params,
        templatePath,
        additionnalParams,
      });

      console.log("generating with stream");

      if (this.plugin.processing && !additionnalParams.signal) {
        logger("streamGenerate error", "There is another generation process");
        throw "There is another generation process";
      }

      const { options, template } = context;

      const { reqParams, bodyParams, provider, allParams } =
        this.reqFormatter.getRequestParameters(
          {
            ...params,
            prompt:
              typeof template != "undefined" && !context.context
                ? await template.inputTemplate(options)
                : context.context,
          },
          insertMetadata,
          templatePath,
          additionnalParams
        );

      if (
        !this.LLMProvider ||
        provider.selectedProvider !== this.LLMProvider.id
      )
        await this.loadllm(provider.selectedProvider);

      await providerOptionsValidator(
        this.LLMProvider.provider,
        provider.providerOptions
      );

      if (!additionnalParams.signal)
        this.startLoading(additionnalParams.showSpinner);

      if (!this.LLMProvider?.streamable) {
        logger("streamGenerate error", "LLM not streamable");
        throw "LLM not streamable";
      }

      //const stream = await this.streamRequest(reqParams);
      const stream = async (
        onToken: Parameters<typeof this.LLMProvider.generate>[2],
        onError?: (error: any) => void
      ): Promise<string> => {
        try {
          const k =
            provider.providerOptions.estimatingMode ||
            provider.providerOptions.disableProvider
              ? ""
              : await this.LLMProvider.generate(
                  bodyParams.messages,
                  {
                    ...allParams,
                    ...bodyParams,
                    requestParams: {
                      // body: JSON.stringify(bodyParams),
                      ...reqParams,
                      signal:
                        additionnalParams.signal ||
                        this.signalController?.signal,
                    },
                    otherOptions:
                      this.plugin.settings.LLMProviderOptions[
                        this.LLMProvider.id
                      ],
                    streaming: true,
                    llmPredict: bodyParams.messages?.length == 1,
                  } as any,
                  onToken,
                  provider.providerOptions
                );

          // output template, template used AFTER the generation happens
          return (
            (provider.providerOptions.output?.length
              ? await Handlebars.compile(
                  provider.providerOptions.output.replaceAll("\\n", "\n"),
                  {
                    noEscape: true,
                  }
                )
              : template?.outputTemplate)?.({ ...options, output: k }) || k
          );
        } catch (err: any) {
          onError?.(err);
          return err.message;
        }
      };

      logger("streamGenerate end", {
        stream,
      });

      return stream;
    } catch (error) {
      logger("streamGenerate error", error);
      return Promise.reject(error);
    }
  }

  async batchGenerate(
    context: InputContext[],
    insertMetadata = false,
    params: Partial<typeof this.plugin.settings> = this.plugin.settings,
    templatePath = "",
    additionnalParams = {
      showSpinner: true,
      insertMode: false,
    },
    onOneFinishs?: (content: string, index: number) => void
  ) {
    try {
      logger("chain", {
        context,
        insertMetadata,
        params,
        templatePath,
        additionnalParams,
      });

      if (this.plugin.processing) {
        logger("generate error", "There is another generation process");
        return Promise.reject(new Error("There is another generation process"));
      }

      this.startLoading();

      const batches = await Promise.all(
        context.map(async (ctxt) => {
          return this.reqFormatter.getRequestParameters(
            {
              ...params,
              prompt:
                typeof ctxt.template != "undefined" && !ctxt.context
                  ? await ctxt.template.inputTemplate(ctxt.options)
                  : ctxt.context,
            },
            insertMetadata,
            templatePath
          );
        })
      );

      return await this.LLMProvider.generateBatch(
        batches.map((batch) => batch.bodyParams.messages),
        {
          ...params,
          stream: false,
        },
        context[0].options,
        onOneFinishs
      );
    } catch (err: any) {
      this.endLoading();
      this.plugin.handelError(err);
    } finally {
      this.endLoading();
    }
  }

  async generate(
    context: InputContext,
    insertMetadata = false,
    params: Partial<
      typeof this.plugin.settings & { disableProvider: boolean }
    > = this.plugin.settings,
    templatePath = "",
    additionnalParams = {
      showSpinner: true,
      insertMode: false,
    }
  ) {
    try {
      logger("generate", {
        context,
        insertMetadata,
        params,
        templatePath,
        additionnalParams,
      });

      const { options, template } = context;

      if (this.plugin.processing) {
        logger("generate error", "There is another generation process");
        return Promise.reject(new Error("There is another generation process"));
      }

      const { reqParams, bodyParams, provider, allParams } =
        this.reqFormatter.getRequestParameters(
          {
            ...params,
            prompt:
              typeof template != "undefined" && !context.context?.trim()
                ? await template.inputTemplate(options)
                : context.context,
          },
          insertMetadata,
          templatePath
        );

      if (
        !this.LLMProvider ||
        provider.selectedProvider !== this.LLMProvider.id
      )
        await this.loadllm(provider.selectedProvider);

      await providerOptionsValidator(
        this.LLMProvider.provider,
        provider.providerOptions
      );

      this.startLoading(additionnalParams?.showSpinner);

      let result =
        provider.providerOptions.estimatingMode ||
        provider.providerOptions.disableProvider
          ? ""
          : await this.LLMProvider.generate(
              bodyParams.messages,
              {
                ...allParams,
                ...bodyParams,
                requestParams: {
                  // body: JSON.stringify(bodyParams),
                  ...reqParams,
                  signal: this.signalController?.signal,
                },
                otherOptions:
                  this.plugin.settings.LLMProviderOptions[this.LLMProvider.id],
                stream: false,
                llmPredict: bodyParams.messages?.length == 1,
              },
              undefined,
              provider.providerOptions
            );

      // Remove leading/trailing newlines
      //   result = result.trim();

      // output template, template used AFTER the generation happens

      result =
        (provider.providerOptions.output?.length
          ? await Handlebars.compile(
              provider.providerOptions.output.replaceAll("\\n", "\n"),
              {
                noEscape: true,
              }
            )
          : template?.outputTemplate)?.({ ...options, output: result }) ||
        result;

      logger("generate end", {
        result,
      });

      return result;
    } catch (error) {
      logger("generate error", error);
      this.endLoading(additionnalParams?.showSpinner);
      return Promise.reject(error);
    } finally {
      this.endLoading(additionnalParams?.showSpinner);
    }
  }

  protected startLoading(showSpinner?: boolean) {
    this.signalController = new AbortController();
    this.plugin.startProcessing(showSpinner);
  }

  endLoading(showSpinner?: boolean) {
    this.signalController?.abort();
    this.signalController = undefined;
    this.plugin.endProcessing(showSpinner);
  }
}