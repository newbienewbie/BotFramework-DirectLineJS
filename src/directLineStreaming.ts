// In order to keep file size down, only import the parts of rxjs that we use

import { AjaxResponse, AjaxRequest } from 'rxjs/observable/dom/AjaxObservable';
import { BehaviorSubject } from 'rxjs/BehaviorSubject';
import { Observable } from 'rxjs/Observable';
import { Subscriber } from 'rxjs/Subscriber';
import { Subscription } from 'rxjs/Subscription';
import * as BFSE from 'botframework-streaming-extensions';

import { mergeMap, finalize } from 'rxjs/operators';
import { _throw} from 'rxjs/observable/throw'
import { timer} from 'rxjs/observable/timer'

import 'rxjs/add/operator/catch';
import 'rxjs/add/operator/combineLatest';
import 'rxjs/add/operator/count';
import 'rxjs/add/operator/delay';
import 'rxjs/add/operator/do';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/mergeMap';
import 'rxjs/add/operator/retryWhen';
import 'rxjs/add/operator/share';
import 'rxjs/add/operator/take';

import 'rxjs/add/observable/dom/ajax';
import 'rxjs/add/observable/empty';
import 'rxjs/add/observable/from';
import 'rxjs/add/observable/interval';
import 'rxjs/add/observable/of';
import 'rxjs/add/observable/throw';

import dedupeFilenames from './dedupeFilenames';

import {Media, Activity, Message, IBotConnection, Conversation, ConnectionStatus,DirectLineOptions} from './directLine';

const POLLING_INTERVAL_LOWER_BOUND: number = 200; //ms

interface ActivityGroup {
    activities: Activity[],
    watermark: string
}

class StreamHandler implements BFSE.RequestHandler {
    public subscriber: Subscriber<ActivityGroup>;

    constructor(s: Subscriber<ActivityGroup>) {
        this.subscriber = s;
    }

    async processRequest(request: BFSE.IReceiveRequest, logger?: any): Promise<BFSE.StreamingResponse> {
        let stream0 = request.streams.shift();
        let activitySetJson = await stream0.readAsString();
        let activitySet = JSON.parse(activitySetJson);

        if (activitySet.activities.length != 1) {
            // Only one activity is expected in a set in streaming
            this.subscriber.error(activitySet)
            let r = new BFSE.StreamingResponse();
            r.statusCode = 500;
            return r;
        }

        var attachments = activitySet.activities[0].attachments;
        let stream: BFSE.ContentStream;
        while (stream = request.streams.shift()) {
            let atch = await stream.readAsString();
            var dataUri = "data:text/plain;base64," + atch;
            attachments.push({ contentType: stream.contentType, contentUrl: dataUri });
        }

        activitySet.activities[0].attachments = attachments;
        this.subscriber.next(activitySet)
        let r = new BFSE.StreamingResponse();
        r.statusCode = 200;
        return r;
    }
}

export class DirectLineStreaming implements IBotConnection {
    public connectionStatus$ = new BehaviorSubject(ConnectionStatus.Uninitialized);
    public activity$: Observable<Activity>;

    private domain = "https://directline.botframework.com/v3/directline";
    private webSocket: boolean;
    private streamingWebSocket: boolean;

    private conversationId: string;
    private expiredTokenExhaustion: Function;
    private secret: string;
    private token: string;
    private watermark = '';
    private streamUrl: string;
    private _botAgent = '';
    private _userAgent: string;
    public referenceGrammarId: string;
    private streamConnection: BFSE.WebSocketClient;

    private pollingInterval: number = 1000; //ms

    private tokenRefreshSubscription: Subscription;

    private ending: boolean;

    constructor(options: DirectLineOptions) {
        this.secret = options.secret;
        this.token = options.secret || options.token;
        this.webSocket = (options.webSocket === undefined ? true : options.webSocket) && typeof WebSocket !== 'undefined' && WebSocket !== undefined;
        this.streamingWebSocket = options.streamingWebSocket;

        if (options.domain) {
            this.domain = options.domain;
        }

        if (options.conversationId) {
            this.conversationId = options.conversationId;
        }

        if (options.watermark) {
            this.watermark =  options.watermark;
        }

        if (options.streamUrl) {
            if (options.token && options.conversationId) {
                this.streamUrl = options.streamUrl;
            } else {
                console.warn('DirectLineJS: streamUrl was ignored: you need to provide a token and a conversationid');
            }
        }

        const parsedPollingInterval = ~~options.pollingInterval;

        if (parsedPollingInterval < POLLING_INTERVAL_LOWER_BOUND) {
            if (typeof options.pollingInterval !== 'undefined') {
                console.warn(`DirectLineJS: provided pollingInterval (${ options.pollingInterval }) is under lower bound (200ms), using default of 1000ms`);
            }
        } else {
            this.pollingInterval = parsedPollingInterval;
        }

        this.activity$ = this.streamingWebSocketActivity$().share();
    }



    public reconnect(conversation: Conversation) {
    }

    end() {
        if (this.tokenRefreshSubscription)
            this.tokenRefreshSubscription.unsubscribe();
        this.ending = true;
        this.connectionStatus$.next(ConnectionStatus.Ended);
    }

    getSessionId(): Observable<string> {
      return Observable.create((s) => {
        s.next(100);

      });
    }

    postActivity(activity: Activity) {
        console.log("Posting a streaming activity " + this.conversationId )
        // Use postMessageWithAttachments for messages with attachments that are local files (e.g. an image to upload)
        // Technically we could use it for *all* activities, but postActivity is much lighter weight
        // So, since WebChat is partially a reference implementation of Direct Line, we implement both.
        if (activity.type === "message" && activity.attachments && activity.attachments.length > 0)
            return this.postMessageWithAttachments(activity);

            console.log("Posting an activity 1")
            let resp$ = Observable.create(subscriber => {
                console.log("Posting an activity 2")
                let request = BFSE.StreamingRequest.create('POST', '/v3/directline/conversations/' + this.conversationId + '/activities');
                request.setBody(JSON.stringify(activity));
                this.streamConnection.send(request)
                    .then((resp) => {
                console.log("Posting an activity 3")
                        subscriber.next(resp.statusCode);
                    })
                    .catch((e) => {
                        console.log("DID WE CATCH IT "  + e.message);
                        this.connectionStatus$.next(ConnectionStatus.Connecting);

                    });
            });
            return resp$;
    }

  private postMessageWithAttachments(message: Message) {
    const { attachments, ...messageWithoutAttachments } = message;

    let httpContentList = [];
    return Observable.create(subscriber => {
      return Observable.from(attachments || [])
        .flatMap((media: Media) =>
          Observable.ajax({
            method: "GET",
            url: media.contentUrl,
            responseType: 'arraybuffer'
          })
            .do(ajaxResponse => {
              let buffer = new Buffer(ajaxResponse.response);
              let stream = new BFSE.SubscribableStream();
              stream.write(buffer);
              let httpContent = new BFSE.HttpContent({ type: media.contentType, contentLength: buffer.length }, stream);
              httpContentList.push(httpContent);
            }))
        .count()
        .flatMap(_ => {
          let url = `/v3/directline/conversations/${this.conversationId}/users/${messageWithoutAttachments.from.id}/upload`;
          let request = BFSE.StreamingRequest.create('PUT', url);
          var activityStream = new BFSE.SubscribableStream();
          activityStream.write(JSON.stringify(messageWithoutAttachments), 'utf-8');
          request.addStream(new BFSE.HttpContent({ type: "application/vnd.microsoft.activity", contentLength: activityStream.length }, activityStream));
          httpContentList.forEach(e => request.addStream(e));
          return this.streamConnection.send(request);
        })
        .do(resp => {
          if (resp.streams && resp.streams.length != 1) {
            subscriber.error("Invalid stream count " + resp.streams.length);
          } else {
            resp.streams[0].readAsJson()
              .then(json => {
                subscriber.next(json['Id'])
              })
          }
        })
        .subscribe(_ => _) // force execution
    })
  }

    private observableFromActivityGroup(activityGroup: ActivityGroup) {
        if (activityGroup.watermark)
            this.watermark = activityGroup.watermark;
        return Observable.from(activityGroup.activities);
    }

    private streamingWebSocketActivity$():  Observable<Activity> {
      console.log("STREAMING CALLED");
        let re = new RegExp('^http(s?)');
        if (!re.test(this.domain)) throw ("Domain must begin with http or https");
        let wsUrl = this.domain.replace(re, "ws$1") + '/conversations/connect?token=' + this.token + '&conversationId=' + this.conversationId;

            try
            {
        let obs1$ = Observable.create((subscriber: Subscriber<ActivityGroup>) => {
                console.log("HERE");
            this.streamConnection = new BFSE.WebSocketClient({ url: wsUrl, requestHandler: new StreamHandler(subscriber) });
            this.streamConnection.connect().then(() => {
                this.connectionStatus$.next(ConnectionStatus.Online);
                setTimeout(() => {
                    console.log("FAILED TO CONNECT");
                    //this.connectionStatus$.next(ConnectionStatus.FailedToConnect);

                }, 10000);
                let r = BFSE.StreamingRequest.create('POST', '/v3/directline/conversations');
                this.streamConnection.send(r).then(_ => console.log("WebSocket Connection Succeeded"));
            }).catch(e => {
                console.log("POST CAUGHT ");
                console.log(e);
                this.streamUrl = null;
                this.streamConnection =null;
                this.connectionStatus$.next(ConnectionStatus.Uninitialized);
                subscriber.error(e)
            });
        }).flatMap(activityGroup => this.observableFromActivityGroup(activityGroup)).share();

        return this.fallback$(obs1$, () => this.streamingWebSocket, obs1$);
        }catch(e) {
            console.log("EEEEEEEE " + e);
        }
    }

    // Returns the delay duration in milliseconds
    private getRetryDelay() {
        return Math.floor(3000 + Math.random() * 12000);
    }


    private fallback$(o1$, retryNeeded, o2$) {
        let rw$ = (attempts: Observable<any>) => {
            return attempts.pipe(
                mergeMap((error, i) => {
                    console.log("RETRY NEEDED? " + i);
                    if (retryNeeded()) {
                        return timer(this.getRetryDelay());
                    }
                    return _throw(error);
                }),
                finalize(() => console.log('Completed first stream'))
            );
        }

        return Observable.create((s) => {
            o1$.retryWhen(rw$).subscribe(v => {
                s.next(v)
            }, (_) => {
              console.log("FALLING BACK...");
                o2$.subscribe(v => {
                    s.next(v);
                })
            })
        });
    }
}